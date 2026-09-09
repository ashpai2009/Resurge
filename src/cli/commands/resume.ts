import type { ParsedArgs } from '../args.js';
import { flagBool, flagString } from '../args.js';
import { JsonTaskStore } from '../../persistence/json-store.js';
import { acquireLease } from '../../persistence/lease.js';
import { createAdapter } from '../../agents/registry.js';
import { DnsNetworkChecker } from '../../network/connectivity.js';
import { Supervisor } from '../../supervisor/supervisor.js';
import { explainUnforceable, isForceable } from '../../recovery/review-reason.js';
import { LeaseUnavailableError } from '../../types/lease.js';
import { dim, formatReview, red, title } from '../format.js';
import { report } from './run.js';
import { logger } from '../../util/logger.js';
import type { Task } from '../../types/task.js';
import * as path from 'node:path';

/**
 * `resurge resume <task-id> [--force]`
 *
 * --force suppresses only *forceable* review reasons. It never skips the gate:
 * orphan reconciliation and the full pre-resume checks run either way, and a
 * non-forceable blocker found during that rerun still stops the resume.
 */
export interface ResumeCommandOptions {
  detached?: boolean;
  logPath?: string;
}

export async function resumeCommand(
  args: ParsedArgs,
  options: ResumeCommandOptions = {},
): Promise<number> {
  const taskId = args.positional[0];
  if (!taskId) {
    process.stderr.write('usage: resurge resume <task-id> [--force]\n');
    return 64;
  }

  const store = new JsonTaskStore();
  const loaded = store.load(taskId);
  if (!loaded) {
    process.stderr.write(`No task ${taskId}.\n`);
    return 1;
  }
  if (!loaded.ok) {
    process.stderr.write(`Cannot resume ${taskId}: stored state could not be read.\n${loaded.reason}\n`);
    return 1;
  }

  let task = loaded.task;
  const force = flagBool(args, 'force');

  const initialBlock = reportResumeBlock(task, taskId, force);
  if (initialBlock !== null) return initialBlock;

  let lease;
  try {
    lease = await acquireLease(taskId);
  } catch (err) {
    if (err instanceof LeaseUnavailableError) {
      process.stderr.write(`Cannot resume: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const refreshed = store.load(taskId);
  if (!refreshed?.ok) {
    await lease.release();
    process.stderr.write(`Cannot resume ${taskId}: task state changed or became unreadable.\n`);
    return 1;
  }
  task = refreshed.task;
  const refreshedBlock = reportResumeBlock(task, taskId, force);
  if (refreshedBlock !== null) {
    await lease.release();
    return refreshedBlock;
  }

  if (options.detached) {
    task = await store.save(lease, {
      ...task,
      detached: true,
      log_path: options.logPath ?? task.log_path ?? null,
    });
  }

  const cwd = path.resolve(
    flagString(args, 'cwd') ??
      task.workdir ??
      task.repo_at_interruption?.root ??
      task.repo_at_start?.root ??
      process.cwd(),
  );
  const scenario = flagString(args, 'scenario');
  const adapter = createAdapter(task.agent, scenario ? { scenario } : {});

  const supervisor = new Supervisor(task, {
    adapter,
    store,
    lease,
    network: new DnsNetworkChecker(),
    cwd,
    onOutput: (chunk, stream) => {
      (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
    },
  });

  const onSignal = () => void supervisor.requestPause();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const final = await supervisor.run({ force, resuming: true });
    return report(final);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await lease.release().catch((err) => logger.debug('lease release failed', err));
  }
}

function reportResumeBlock(task: Task, taskId: string, force: boolean): number | null {
  if (task.state === 'COMPLETED') {
    process.stdout.write(`Task ${taskId} is already complete.\n`);
    return 0;
  }

  // A non-forceable blocker is one where proceeding could put two agents on one
  // repository, or where the state itself is untrustworthy. No flag overrides
  // that; the user has to resolve the underlying situation.
  if (task.review_reason && !isForceable(task.review_reason)) {
    process.stderr.write(
      `${red('Cannot resume')} - ${explainUnforceable(task.review_reason)}\n\n` +
        `${formatReview(task.review_reason)}\n\n` +
        `${dim('--force does not override this.')}\n`,
    );
    return 1;
  }

  if (task.review_reason && !force) {
    process.stderr.write(
      `${title('This task is blocked pending review')}\n\n${formatReview(task.review_reason)}\n\n` +
        `${dim(`Review the situation, then re-run with --force to resume anyway:`)}\n` +
        `  resurge resume ${taskId} --force\n`,
    );
    return 1;
  }
  return null;
}
