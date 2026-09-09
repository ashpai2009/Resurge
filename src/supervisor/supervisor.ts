import type { AgentAdapter, AgentProcess } from '../types/agent.js';
import type { ReviewReason, Task } from '../types/task.js';
import type { NetworkChecker } from '../network/connectivity.js';
import type { TaskStore } from '../persistence/store.js';
import type { LeaseHandle } from '../persistence/lease.js';
import { FailureDetector } from '../failure/detector.js';
import { isStructuredFailureEvent } from '../failure/evidence.js';
import { isCleanExit } from '../types/failure.js';
import type { FailureEvent } from '../types/failure.js';
import { planRecovery, type RecoveryAction } from '../recovery/planner.js';
import { preResumeGate } from '../recovery/executor.js';
import { buildContinuationPrompt, buildResumeNudge } from '../recovery/continuation-prompt.js';
import { evaluateCompletion } from '../recovery/completion-policy.js';
import { reviewReason } from '../recovery/review-reason.js';
import { captureSnapshot } from '../repo/snapshot.js';
import { Heartbeat } from './heartbeat.js';
import { reconcileOrphan } from './orphan.js';
import { stopAgent } from './pause.js';
import { OutputBuffer } from './output-buffer.js';
import { DEFAULT_POLICY, type Policy } from './policy.js';
import { JsonlFramer } from '../util/jsonl.js';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import type { Sleeper } from '../util/sleep.js';
import { AbortError, realSleeper } from '../util/sleep.js';
import { logger } from '../util/logger.js';
import { processIdentity } from '../util/platform.js';

export interface SupervisorDeps {
  adapter: AgentAdapter;
  store: TaskStore;
  lease: LeaseHandle;
  network: NetworkChecker;
  clock?: Clock;
  sleeper?: Sleeper;
  policy?: Policy;
  cwd: string;
  /** Streams agent output to the terminal. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface RunOptions {
  /** Suppresses forceable review blockers. Never skips the gate itself. */
  force?: boolean;
  /** Resume an existing task rather than starting a new one. */
  resuming?: boolean;
}

/**
 * The supervision loop.
 *
 * This is the only module allowed to coordinate across the others, and it does
 * so in a fixed order that encodes the safety model:
 *
 *   reconcile orphans -> run -> observe the exit -> snapshot the repo ->
 *   persist -> classify -> plan -> gate -> resume
 *
 * State is written before every risky action, so a crash of Resurge itself
 * leaves a truthful record on disk rather than an optimistic one.
 */
export class Supervisor {
  private readonly d: SupervisorDeps;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly policy: Policy;
  private readonly detector: FailureDetector;

  private task: Task;
  private current: AgentProcess | null = null;
  private launching = false;
  private pauseDeferredDuringLaunch = false;
  private heartbeat: Heartbeat | null = null;
  private pauseRequested = false;
  private readonly abort = new AbortController();
  private persistChain: Promise<void> = Promise.resolve();
  private pendingSessionId: string | null = null;

  constructor(task: Task, deps: SupervisorDeps) {
    this.task = task;
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.sleeper = deps.sleeper ?? realSleeper;
    this.policy = deps.policy ?? DEFAULT_POLICY;
    this.detector = new FailureDetector(this.clock);
  }

  get snapshot(): Task {
    return this.task;
  }

  /** Runs until the task reaches a state no automatic action can leave. */
  async run(options: RunOptions = {}): Promise<Task> {
    const orphan = reconcileOrphan(this.task);
    if (orphan.kind === 'BLOCKED') {
      // Not overridable by --force: a live orphan is exactly the case where
      // proceeding would put two agents on one repository.
      return this.escalate(orphan.reason);
    }

    if (options.resuming) {
      const gate = await this.gate(options.force ?? false);
      if (gate) return gate;
    }

    this.startHeartbeat();
    try {
      for (;;) {
        const outcome = await this.runOnce();
        if (outcome.kind === 'DONE') return this.task;
        if (outcome.kind === 'PAUSED') return this.task;

        const action = planRecovery(this.task, outcome.failure, this.policy);
        const next = await this.applyRecovery(action, options.force ?? false);
        if (next === 'STOP') return this.task;
      }
    } finally {
      this.stopHeartbeat();
    }
  }

  /** One launch-observe-classify cycle. */
  private async runOnce(): Promise<
    { kind: 'DONE' } | { kind: 'PAUSED' } | { kind: 'FAILED'; failure: FailureEvent }
  > {
    const stdout = new OutputBuffer(this.policy.outputTailBytes);
    const stderr = new OutputBuffer(this.policy.outputTailBytes);
    const framer = new JsonlFramer();
    const events: unknown[] = [];

    this.launching = true;
    let proc: AgentProcess;
    try {
      proc = await this.launch();
    } catch (err) {
      this.launching = false;
      const interruption = await captureSnapshot(this.d.cwd, this.clock);
      if (this.pauseRequested) {
        await this.persist({ state: 'PAUSED', child: null, repo_at_interruption: interruption });
        return { kind: 'PAUSED' };
      }
      const failure: FailureEvent = {
        type: 'UNKNOWN_FAILURE',
        evidence: `agent launch failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        confidence: 1,
        detectedAt: this.clock.now().toISOString(),
        source: 'exit',
      };
      await this.persist({ child: null, repo_at_interruption: interruption, failure });
      return { kind: 'FAILED', failure };
    }
    this.launching = false;
    this.current = proc;

    const startedMs = this.clock.now().getTime();
    await this.persist({
      state: 'RUNNING',
      child: proc.pid
        ? {
            pid: proc.pid,
            pgid: proc.pgid ?? proc.pid,
            identity: identityOf(proc),
            started_at: proc.startedAt,
          }
        : null,
    });

    proc.onStdout((chunk) => {
      stdout.append(chunk);
      this.d.onOutput?.(chunk, 'stdout');
      for (const line of framer.push(chunk)) {
        if (line.json === null) continue;
        rememberFailureEvent(events, line.json);
        this.maybeAdoptSession(line.json);
      }
    });
    proc.onStderr((chunk) => {
      stderr.append(chunk);
      this.d.onOutput?.(chunk, 'stderr');
    });

    // A pause can arrive while an adapter is asynchronously launching. In that
    // window requestPause cannot signal a process yet, so finish the confirmed
    // stop as soon as the process becomes observable.
    if (this.pauseDeferredDuringLaunch) {
      await this.persist({ state: 'STOPPING' });
      const outcome = await stopAgent(proc, this.policy.stopGraceMs);
      this.abort.abort();
      if (outcome.kind === 'UNKILLABLE') {
        await this.escalate(
          reviewReason(
            'UNKILLABLE_CHILD',
            `The agent process (pid ${outcome.pid}) did not exit after SIGTERM and SIGKILL. ` +
              `The task is NOT paused; that process may still be running.`,
          ),
        );
        return { kind: 'DONE' };
      }
    }

    const exit = await proc.wait();
    for (const line of framer.flush()) {
      if (line.json === null) continue;
      rememberFailureEvent(events, line.json);
      this.maybeAdoptSession(line.json);
    }
    this.current = null;

    // The interruption snapshot is captured HERE: immediately after the child
    // exits, before any waiting or recovery. It is the baseline the pre-resume
    // gate compares against, so anything the agent committed while supervised
    // is already inside it and will not block the resume.
    const interruption = await captureSnapshot(this.d.cwd, this.clock);

    const ranCleanlyFor = this.clock.now().getTime() - startedMs;
    const tail = stdout.text;

    if (this.pauseRequested) {
      await this.persist({
        state: 'PAUSED',
        child: null,
        repo_at_interruption: interruption,
        last_output_tail: tail,
      });
      return { kind: 'PAUSED' };
    }

    if (isCleanExit(exit) && events.length === 0) {
      await this.persist({
        state: 'AGENT_EXITED_SUCCESSFULLY',
        child: null,
        repo_at_interruption: interruption,
        last_output_tail: tail,
        failure: null,
      });
      await this.finishCompletion();
      return { kind: 'DONE' };
    }

    const failure = this.detector.detect({
      exit,
      stdoutTail: stdout.text,
      stderrTail: stderr.text,
      jsonlEvents: events,
    })!;

    // Persist before attempting anything risky.
    await this.persist({
      child: null,
      repo_at_interruption: interruption,
      last_output_tail: tail,
      failure,
      attempts: {
        ...this.task.attempts,
        crash:
          failure.type === 'AGENT_CRASH'
            ? ranCleanlyFor >= this.policy.crashCounterResetMs
              ? 1
              : this.task.attempts.crash + 1
            : this.task.attempts.crash,
      },
    });

    return { kind: 'FAILED', failure };
  }

  private async launch(): Promise<AgentProcess> {
    const { adapter } = this.d;
    if (this.task.session_id && adapter.supportsSessionResume()) {
      return adapter.resume(this.task.session_id, this.task, buildResumeNudge(this.task));
    }
    if (this.task.attempts.total_resumes > 0 || this.task.failure) {
      return adapter.startFresh(this.task, buildContinuationPrompt(this.task));
    }
    return adapter.start(this.task, this.task.goal);
  }

  /** Session ids are persisted the instant they are seen, before anything can fail. */
  private maybeAdoptSession(event: unknown): void {
    if (this.task.session_id || this.pendingSessionId) return;
    const id = this.d.adapter.detectSessionId(event);
    if (!id) return;
    this.pendingSessionId = id;
    void this.persist({ session_id: id })
      .catch((err) => logger.warn('could not persist session id', err))
      .finally(() => {
        this.pendingSessionId = null;
      });
  }

  private async applyRecovery(action: RecoveryAction, force: boolean): Promise<'CONTINUE' | 'STOP'> {
    logger.info(action.why);

    switch (action.kind) {
      case 'ESCALATE':
        // An unexplained agent failure is a judgement call for the user, not a
        // corrupted store: it keeps the spec's UNKNOWN_FAILURE state and stays
        // forceable, unlike the blockers that risk a duplicate agent.
        await this.escalate(
          reviewReason(action.reason, action.why),
          action.reason === 'UNCLASSIFIED_FAILURE' ? 'UNKNOWN_FAILURE' : 'REQUIRES_REVIEW',
        );
        return 'STOP';

      case 'START_FRESH':
        // The one case that abandons a session, and only on explicit proof the
        // session is gone.
        await this.persist({ session_id: null, state: 'WAITING_TO_RESUME' });
        break;

      case 'WAIT_UNTIL': {
        await this.persist({ state: action.state, resume_at: action.until.toISOString() });
        const ms = action.until.getTime() - this.clock.now().getTime();
        if (!(await this.wait(Math.max(0, ms)))) return 'STOP';
        break;
      }

      case 'WAIT_BACKOFF': {
        const until = new Date(this.clock.now().getTime() + action.ms);
        await this.persist({ state: action.state, resume_at: until.toISOString() });
        if (!(await this.wait(action.ms))) return 'STOP';
        break;
      }

      case 'WAIT_FOR_NETWORK': {
        await this.persist({ state: action.state, resume_at: null });
        const ok = await this.d.network.waitForConnectivity(action.budgetMs, this.abort.signal);
        if (this.pauseRequested) return 'STOP';
        if (!ok) logger.warn('continuing without confirmed connectivity');
        break;
      }

      case 'RESTART': {
        await this.persist({ state: action.state, resume_at: null });
        if (!(await this.wait(action.delayMs))) return 'STOP';
        break;
      }
    }

    await this.persist({ state: 'WAITING_TO_RESUME' });

    const blocked = await this.gate(force);
    if (blocked) return 'STOP';

    await this.persist({
      attempts: { ...this.task.attempts, total_resumes: this.task.attempts.total_resumes + 1 },
    });
    return 'CONTINUE';
  }

  /** Runs the shared pre-resume gate; returns a task when it blocks. */
  private async gate(force: boolean): Promise<Task | null> {
    const priorReason = this.task.review_reason;
    const result = await preResumeGate(
      this.task,
      this.d.adapter,
      this.d.network,
      { force, cwd: this.d.cwd },
      this.clock,
      this.policy.networkBudgetMs,
    );
    if (result.kind === 'BLOCKED') return this.escalate(result.reason);
    if (force && priorReason) {
      const patch: Partial<Task> = { review_reason: null };
      if (
        priorReason.kind === 'REPO_MISMATCH' ||
        priorReason.kind === 'MISSING_INTERRUPTION_SNAPSHOT'
      ) {
        // --force accepts the repository as it exists now. Persist that new
        // boundary so the very next automatic recovery is compared against a
        // baseline that can actually pass.
        patch.repo_at_interruption = result.current;
      }
      if (priorReason.kind === 'REPEATED_CRASHES') {
        // A human-approved retry begins a fresh bounded retry window.
        patch.attempts = { ...this.task.attempts, crash: 0 };
      }
      await this.persist(patch);
    }
    return null;
  }

  private async wait(ms: number): Promise<boolean> {
    try {
      await this.sleeper.sleep(ms, this.abort.signal);
      return !this.pauseRequested;
    } catch (err) {
      if (err instanceof AbortError) return false;
      throw err;
    }
  }

  private async finishCompletion(): Promise<void> {
    const outcome = await evaluateCompletion(this.task);
    if (outcome.kind === 'COMPLETED') {
      await this.persist({ state: 'COMPLETED', review_reason: null });
    } else if (outcome.kind === 'REQUIRES_REVIEW') {
      await this.escalate(
        reviewReason('VERIFY_COMMAND_FAILED', `${outcome.message}\n\n${outcome.output}`),
      );
    }
    logger.info(outcome.message);
  }

  private async escalate(
    reason: ReviewReason,
    state: 'REQUIRES_REVIEW' | 'UNKNOWN_FAILURE' = 'REQUIRES_REVIEW',
  ): Promise<Task> {
    await this.persist({ state, review_reason: reason, resume_at: null });
    return this.task;
  }

  private persist(patch: Partial<Task>): Promise<void> {
    // JSON writes are atomically serialized by the lease guard, but merging a
    // patch before waiting for that guard can still lose a concurrent update.
    // Build each next record only after the previous Supervisor write settles.
    const operation = this.persistChain.then(async () => {
      this.task = await this.d.store.save(this.d.lease, { ...this.task, ...patch });
    });
    this.persistChain = operation.catch(() => undefined);
    return operation;
  }

  // --- heartbeat + control requests -----------------------------------------

  private startHeartbeat(): void {
    this.heartbeat = new Heartbeat(
      this.d.lease,
      this.task.task_id,
      this.clock,
      this.policy.heartbeatMs,
      async (kind) => {
        if (kind === 'pause') await this.requestPause();
      },
    );
    this.heartbeat.start();
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  /**
   * Confirmed pause: request -> stop the process group -> await its death ->
   * only then record PAUSED.
   */
  async requestPause(): Promise<void> {
    if (this.pauseRequested) return;
    this.pauseRequested = true;
    await this.persist({ state: 'PAUSE_REQUESTED' });

    const proc = this.current;
    if (!proc) {
      this.abort.abort();
      if (this.launching) {
        this.pauseDeferredDuringLaunch = true;
        return;
      }
      await this.persist({ state: 'PAUSED', child: null });
      return;
    }

    await this.persist({ state: 'STOPPING' });
    const outcome = await stopAgent(proc, this.policy.stopGraceMs);
    this.abort.abort();

    if (outcome.kind === 'UNKILLABLE') {
      await this.escalate(
        reviewReason(
          'UNKILLABLE_CHILD',
          `The agent process (pid ${outcome.pid}) did not exit after SIGTERM and SIGKILL. ` +
            `The task is NOT paused; that process may still be running.`,
        ),
      );
      return;
    }
    // PAUSED is written by runOnce once the process has actually exited.
  }
}

/** Failure classification needs only protocol error events, not the full run. */
const MAX_FAILURE_EVENTS = 64;

function rememberFailureEvent(events: unknown[], event: unknown): void {
  if (!isStructuredFailureEvent(event)) return;
  events.push(event);
  if (events.length > MAX_FAILURE_EVENTS) events.splice(0, events.length - MAX_FAILURE_EVENTS);
}

/**
 * Records the child's identity in the SAME form probeProcess() reports, so a
 * later orphan check can actually compare them. Storing something merely
 * unique here (a spawn timestamp, say) would make every liveness comparison
 * mismatch, and Resurge would conclude "PID reuse, orphan is gone" about a
 * process that is very much alive.
 */
function identityOf(proc: AgentProcess): string {
  if (proc.pid === undefined) return 'unknown';
  return processIdentity(proc.pid) ?? `unknown-${proc.pid}@${proc.startedAt}`;
}
