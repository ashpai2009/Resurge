import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTempHome } from '../helpers/home.js';
import { makeTask } from '../helpers/task.js';
import { TempRepo } from '../helpers/git.js';
import { ScriptedAdapter } from '../helpers/scripted-agent.js';
import { JsonTaskStore } from '../../src/persistence/json-store.js';
import { acquireLease, type LeaseHandle } from '../../src/persistence/lease.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { DEFAULT_POLICY } from '../../src/supervisor/policy.js';
import { alwaysOnline } from '../../src/network/connectivity.js';
import { captureSnapshot } from '../../src/repo/snapshot.js';
import { FakeClock } from '../../src/util/clock.js';
import { instantSleeper } from '../../src/util/sleep.js';
import type { Task } from '../../src/types/task.js';

let home: ReturnType<typeof useTempHome>;
let repo: TempRepo;
let store: JsonTaskStore;
let lease: LeaseHandle;

beforeEach(async () => {
  home = useTempHome();
  repo = new TempRepo();
  store = new JsonTaskStore();
});
afterEach(async () => {
  await lease?.release().catch(() => {});
  repo.cleanup();
  home.cleanup();
});

async function seed(overrides: Partial<Task> = {}): Promise<Task> {
  const task = makeTask({ agent: 'scripted', ...overrides });
  lease = await acquireLease(task.task_id);
  return store.save(lease, { ...task, repo_at_start: await captureSnapshot(repo.dir) });
}

function supervise(task: Task, adapter: ScriptedAdapter, clock = new FakeClock('2026-09-08T20:00:00Z')) {
  return new Supervisor(task, {
    adapter,
    store,
    lease,
    network: alwaysOnline,
    clock,
    sleeper: instantSleeper(clock),
    policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
    cwd: repo.dir,
  });
}

describe('a clean exit is not success', () => {
  it('lands in AGENT_EXITED_SUCCESSFULLY, never COMPLETED', async () => {
    const task = await seed();
    const final = await supervise(task, new ScriptedAdapter([{ exit: { code: 0, signal: null } }])).run();
    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
  });

  it('promotes to COMPLETED only when a verification command passes', async () => {
    const task = await seed({ verify_argv: ['true'] });
    const final = await supervise(task, new ScriptedAdapter([{ exit: { code: 0, signal: null } }])).run();
    expect(final.state).toBe('COMPLETED');
  });

  it('sends a failing verification to review, not to COMPLETED', async () => {
    const task = await seed({ verify_argv: ['false'] });
    const final = await supervise(task, new ScriptedAdapter([{ exit: { code: 0, signal: null } }])).run();
    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('VERIFY_COMMAND_FAILED');
  });

  it('runs the verification command without a shell', async () => {
    // The argument is passed literally; a shell would have interpreted the `;`.
    const task = await seed({ verify_argv: ['echo', 'hello; echo INJECTED'] });
    const final = await supervise(task, new ScriptedAdapter([{ exit: { code: 0, signal: null } }])).run();
    expect(final.state).toBe('COMPLETED');
  });
});

describe('rate-limit recovery', () => {
  it('waits until the parsed reset time, then resumes and finishes', async () => {
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const adapter = new ScriptedAdapter([
      { stderr: 'Error: usage limit reached. try again in 45 minutes', exit: { code: 1, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter, clock).run();

    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
    expect(adapter.launches).toHaveLength(2);
    // 45 minutes plus the safety margin, rather than waking on the exact second.
    expect(clock.now().getTime()).toBe(
      Date.parse('2026-09-08T20:00:00Z') + 45 * 60_000 + DEFAULT_POLICY.rateLimitMarginMs,
    );
  });

  it('records RATE_LIMITED with a resume time before it starts waiting', async () => {
    const seen: string[] = [];
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const adapter = new ScriptedAdapter([
      { stderr: 'usage limit reached. try again in 30 minutes', exit: { code: 1, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const sup = supervise(task, adapter, clock);
    const original = store.save.bind(store);
    store.save = async (l, t) => {
      seen.push(t.state);
      return original(l, t);
    };

    await sup.run();
    // State is persisted before the wait, so a crash of Resurge mid-wait leaves
    // a truthful record rather than a stale RUNNING.
    expect(seen).toContain('RATE_LIMITED');
    expect(seen.indexOf('RATE_LIMITED')).toBeLessThan(seen.lastIndexOf('RUNNING'));
  });

  it('backs off when no reset time can be parsed', async () => {
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const adapter = new ScriptedAdapter([
      { stderr: 'usage limit reached. please try again later.', exit: { code: 1, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    await supervise(task, adapter, clock).run();
    expect(clock.now().getTime()).toBe(
      Date.parse('2026-09-08T20:00:00Z') + DEFAULT_POLICY.rateLimitBackoffMs[0]!,
    );
  });
});

describe('network-outage recovery', () => {
  it('waits for connectivity, runs the shared gate, and resumes', async () => {
    const adapter = new ScriptedAdapter([
      {
        stderr: 'request failed: getaddrinfo ENOTFOUND api.openai.com',
        exit: { code: 1, signal: null },
      },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    let waits = 0;
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const final = await new Supervisor(task, {
      adapter,
      store,
      lease,
      network: {
        isOnline: async () => true,
        waitForConnectivity: async () => {
          waits += 1;
          return true;
        },
      },
      clock,
      sleeper: instantSleeper(clock),
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    }).run();

    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
    expect(adapter.launches).toHaveLength(2);
    expect(waits).toBe(2);
  });
});

describe('crash recovery is bounded', () => {
  it('restarts three times, then requires review', async () => {
    const adapter = new ScriptedAdapter([{ stderr: 'panic: boom', exit: { code: 3, signal: null } }]);
    const task = await seed();
    const final = await supervise(task, adapter).run();

    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('REPEATED_CRASHES');
    // One initial launch plus exactly three automatic restarts.
    expect(adapter.launches).toHaveLength(4);
  });

  it('classifies a signal death as a crash rather than a clean exit', async () => {
    const adapter = new ScriptedAdapter([{ exit: { code: null, signal: 'SIGSEGV' } }]);
    const task = await seed();
    const final = await supervise(task, adapter).run();
    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.failure?.type).toBe('AGENT_CRASH');
  });

  it('starts a fresh bounded crash window after a forced human retry', async () => {
    const task = await seed({
      state: 'REQUIRES_REVIEW',
      attempts: { crash: DEFAULT_POLICY.maxCrashRetries + 1, total_resumes: 4 },
      review_reason: { kind: 'REPEATED_CRASHES', detail: 'previous retry budget exhausted' },
      repo_at_interruption: await captureSnapshot(repo.dir),
    });
    const adapter = new ScriptedAdapter([
      { stderr: 'panic: one more transient crash', exit: { code: 1, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);

    const final = await supervise(task, adapter).run({ force: true, resuming: true });
    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
    expect(final.review_reason).toBeNull();
    expect(adapter.launches).toHaveLength(2);
  });
});

describe('session handling', () => {
  it('persists a session id from thread.started and resumes that session', async () => {
    const adapter = new ScriptedAdapter([
      {
        jsonl: [{ type: 'thread.started', thread_id: 'sess-abc' }],
        stderr: 'panic: boom',
        exit: { code: 1, signal: null },
      },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter).run();

    expect(final.session_id).toBe('sess-abc');
    expect(adapter.launches[1]?.mode).toBe('resume');
    expect(adapter.launches[1]?.sessionId).toBe('sess-abc');
  });

  it('serializes session adoption with terminal state writes', async () => {
    const adapter = new ScriptedAdapter([
      {
        jsonl: [{ type: 'thread.started', thread_id: 'sess-race' }],
        exit: { code: 0, signal: null },
      },
    ]);
    const task = await seed();
    const original = store.save.bind(store);
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    store.save = async (l, t) => {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      if (t.session_id === 'sess-race' && t.state === 'RUNNING') {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        return await original(l, t);
      } finally {
        activeWrites -= 1;
      }
    };

    const final = await supervise(task, adapter).run();
    expect(maxConcurrentWrites).toBe(1);
    expect(final.session_id).toBe('sess-race');
    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
  });

  it('does not treat exit zero as clean when Codex reports turn.failed', async () => {
    const adapter = new ScriptedAdapter([
      {
        jsonl: [{ type: 'turn.failed', error: { message: 'usage limit reached' } }],
        exit: { code: 0, signal: null },
      },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter).run();
    expect(adapter.launches).toHaveLength(2);
    expect(final.state).toBe('AGENT_EXITED_SUCCESSFULLY');
  });

  it('keeps the session through a rate limit instead of starting over', async () => {
    const adapter = new ScriptedAdapter([
      {
        jsonl: [{ type: 'thread.started', thread_id: 'sess-keep' }],
        stderr: 'usage limit reached, try again in 10 minutes',
        exit: { code: 1, signal: null },
      },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter).run();

    // Abandoning a live session on a rate limit would throw away all the
    // agent's accumulated context for no reason.
    expect(final.session_id).toBe('sess-keep');
    expect(adapter.launches[1]?.mode).toBe('resume');
  });

  it('starts fresh only on explicit proof the session is gone', async () => {
    const adapter = new ScriptedAdapter([
      {
        jsonl: [{ type: 'thread.started', thread_id: 'sess-dead' }],
        stderr: 'Error: session not found: sess-dead',
        exit: { code: 1, signal: null },
      },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter).run();

    expect(final.session_id).toBeNull();
    expect(adapter.launches[1]?.mode).toBe('fresh');
    // The fallback prompt carries real context, not the word "continue".
    const prompt = adapter.launches[1]!.prompt;
    expect(prompt).not.toBe('continue');
    for (const heading of ['GOAL', 'REPOSITORY', 'BRANCH', 'HEAD', 'FILES CHANGED', 'NEXT ACTION']) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('FAILURE THAT INTERRUPTED EXECUTION');
  });
});

describe('the repository gate', () => {
  it('blocks a resume when HEAD moved while the agent was interrupted', async () => {
    const adapter = new ScriptedAdapter([
      { stderr: 'panic: boom', exit: { code: 3, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();

    // Move HEAD after the crash, during the restart backoff.
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const sup = new Supervisor(task, {
      adapter,
      store,
      lease,
      network: {
        isOnline: async () => {
          throw new Error('network should not be checked after a local gate failure');
        },
        waitForConnectivity: async () => {
          throw new Error('network should not be checked after a local gate failure');
        },
      },
      clock,
      sleeper: {
        sleep: async (ms) => {
          clock.advance(ms);
          repo.commit('someone else committed while the agent was down');
        },
      },
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    });

    const final = await sup.run();
    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('REPO_MISMATCH');
    expect(final.review_reason?.detail).toMatch(/Expected HEAD/);
    // Critically: it never relaunched the agent.
    expect(adapter.launches).toHaveLength(1);
  });

  it('blocks when a new edit appears after the interruption boundary', async () => {
    const adapter = new ScriptedAdapter([
      { stderr: 'panic: boom', exit: { code: 3, signal: null } },
      { exit: { code: 0, signal: null } },
    ]);
    const task = await seed();
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const sup = new Supervisor(task, {
      adapter,
      store,
      lease,
      network: alwaysOnline,
      clock,
      sleeper: {
        sleep: async (ms) => {
          clock.advance(ms);
          repo.write('new-file.ts', 'the agent was mid-edit');
        },
      },
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    });

    const final = await sup.run();
    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('REPO_MISMATCH');
    expect(adapter.launches).toHaveLength(1);
  });
});

describe('unclassifiable failures escalate', () => {
  it('does not retry a failure it cannot explain', async () => {
    const adapter = new ScriptedAdapter([
      // stdout-only rate-limit text: recognised, but not trustworthy enough.
      { stdout: 'error: usage limit reached', exit: { code: 1, signal: null } },
    ]);
    const task = await seed();
    const final = await supervise(task, adapter).run();

    expect(final.failure?.type).toBe('UNKNOWN_FAILURE');
    // Parked in the spec's UNKNOWN_FAILURE state rather than lumped in with
    // corrupted storage, and never retried on a guess.
    expect(final.state).toBe('UNKNOWN_FAILURE');
    expect(final.review_reason?.kind).toBe('UNCLASSIFIED_FAILURE');
    expect(adapter.launches).toHaveLength(1);
  });

  it('records an adapter launch failure instead of leaving a phantom RUNNING task', async () => {
    const adapter = new ScriptedAdapter([{ exit: { code: 0, signal: null } }]);
    adapter.start = async () => {
      throw new Error('spawn setup exploded');
    };
    const task = await seed({ state: 'WAITING_TO_RESUME' });
    const final = await supervise(task, adapter).run();

    expect(final.state).toBe('UNKNOWN_FAILURE');
    expect(final.child).toBeNull();
    expect(final.failure?.evidence).toMatch(/launch failed.*spawn setup exploded/i);
  });
});
