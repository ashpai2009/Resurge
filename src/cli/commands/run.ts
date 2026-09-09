import type { ParsedArgs } from '../args.js';
import { flagBool, flagNumber, flagString } from '../args.js';
import { JsonTaskStore } from '../../persistence/json-store.js';
import { acquireLease } from '../../persistence/lease.js';
import { ensureLayout, newTaskId } from '../../persistence/paths.js';
import { SCHEMA_VERSION } from '../../persistence/schema.js';
import { createAdapter } from '../../agents/registry.js';
import { DnsNetworkChecker } from '../../network/connectivity.js';
import { captureSnapshot } from '../../repo/snapshot.js';
import { Supervisor } from '../../supervisor/supervisor.js';
import { DEFAULT_POLICY } from '../../supervisor/policy.js';
import { LeaseUnavailableError } from '../../types/lease.js';
import type { Task } from '../../types/task.js';
import { colorState, dim, formatReview, title } from '../format.js';
import { logger } from '../../util/logger.js';
import * as path from 'node:path';

/**
 * `resurge run <agent> "<goal>"`
 *
 * Runs in the foreground unless the CLI dispatches it through the detached
 * handoff. State is on disk throughout, so `status` and `list` work from any
 * other shell and survive this process dying.
 */
export interface RunCommandOptions {
  taskId?: string;
  detached?: boolean;
  logPath?: string;
}

export async function runCommand(args: ParsedArgs, options: RunCommandOptions = {}): Promise<number> {
  const [agentName, ...goalParts] = args.positional;
  const goal = goalParts.join(' ').trim();

  if (!agentName || !goal) {
    process.stderr.write('usage: resurge run <agent> "<task>"\n');
    return 64;
  }

  ensureLayout();
  const cwd = path.resolve(flagString(args, 'cwd') ?? process.cwd());
  const scenario = flagString(args, 'scenario');
  const adapter = createAdapter(agentName, scenario ? { scenario } : {});
  const installation = await adapter.installationCheck();
  if (!installation.ok) {
    process.stderr.write(`Cannot start ${agentName}: ${installation.detail}\n`);
    return 1;
  }
  const store = new JsonTaskStore();
  const maxRetries = flagNumber(args, 'max-crash-retries');
  if (
    args.flags.has('max-crash-retries') &&
    (maxRetries === undefined || !Number.isInteger(maxRetries) || maxRetries < 0)
  ) {
    process.stderr.write('--max-crash-retries must be a non-negative integer.\n');
    return 64;
  }

  const now = new Date().toISOString();
  const task: Task = {
    schema_version: SCHEMA_VERSION,
    task_id: options.taskId ?? newTaskId(),
    agent: agentName,
    goal,
    session_id: null,
    workdir: cwd,
    detached: options.detached ?? false,
    log_path: options.logPath ?? null,
    repo_at_start: await captureSnapshot(cwd),
    repo_at_interruption: null,
    // RUNNING is written only after a child has actually launched and its
    // identity is available. A supervisor crash before then remains truthful.
    state: 'WAITING_TO_RESUME',
    failure: null,
    review_reason: null,
    resume_at: null,
    child: null,
    attempts: { crash: 0, total_resumes: 0 },
    last_output_tail: '',
    verify_argv: args.rest.length > 0 ? args.rest : null,
    store_output: !flagBool(args, 'no-store-output'),
    revision: 0,
    created_at: now,
    updated_at: now,
  };

  let lease;
  try {
    lease = await acquireLease(task.task_id);
  } catch (err) {
    if (err instanceof LeaseUnavailableError) {
      process.stderr.write(`Cannot start: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const policy = { ...DEFAULT_POLICY };
  if (maxRetries !== undefined) policy.maxCrashRetries = maxRetries;

  const supervisor = new Supervisor(await store.save(lease, task), {
    adapter,
    store,
    lease,
    network: new DnsNetworkChecker(),
    policy,
    cwd,
    onOutput: (chunk, stream) => {
      (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
    },
  });

  process.stdout.write(`${title(goal)}\n${dim(`task ${task.task_id} - agent ${agentName}`)}\n\n`);

  // Ctrl-C takes the same confirmed-pause path as `resurge pause`, so the
  // recorded state never claims paused while the agent is still alive.
  const onSignal = () => {
    process.stderr.write('\nStopping the agent and recording state...\n');
    void supervisor.requestPause();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const final = await supervisor.run({ force: flagBool(args, 'force') });
    return report(final);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await lease.release().catch((err) => logger.debug('lease release failed', err));
  }
}

export function report(task: Task): number {
  process.stdout.write(`\n${title('State')} ${colorState(task.state)}\n`);
  if (task.review_reason) {
    process.stdout.write(`\n${formatReview(task.review_reason)}\n`);
  }
  if (task.state === 'AGENT_EXITED_SUCCESSFULLY') {
    process.stdout.write(
      `\n${dim('The agent exited cleanly. That is not proof the goal is done.')}\n` +
        `${dim(`Review the work, then run: resurge complete ${task.task_id}`)}\n`,
    );
  }
  return task.state === 'REQUIRES_REVIEW' || task.state === 'UNKNOWN_FAILURE' ? 1 : 0;
}
