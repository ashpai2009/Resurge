import type { Task } from '../types/task.js';
import { probeProcess } from '../util/platform.js';
import { reviewReason } from '../recovery/review-reason.js';
import type { ReviewReason } from '../types/task.js';

export type OrphanVerdict =
  | { kind: 'CLEAR' }
  | { kind: 'BLOCKED'; reason: ReviewReason };

/**
 * Decides whether a previous agent process is still running.
 *
 * A task recorded as RUNNING tells us the supervisor died; it tells us nothing
 * about its child. Resurge will not start a second agent while the first may
 * still be writing to the repository, and it will not kill a process it no
 * longer owns and cannot observe — so an orphan that is provably alive stops
 * the task and reports the PID for a human to deal with.
 */
export function reconcileOrphan(task: Task): OrphanVerdict {
  const child = task.child;
  if (!child) return { kind: 'CLEAR' };
  if (!wasRunning(task)) return { kind: 'CLEAR' };

  const probe = probeProcess(child.pid);

  if (probe.kind === 'DEAD') return { kind: 'CLEAR' };

  if (probe.kind === 'ALIVE') {
    if (isUnverifiedIdentity(child.identity)) {
      return {
        kind: 'BLOCKED',
        reason: reviewReason(
          'LIVE_ORPHAN',
          `A previous agent process (pid ${child.pid}) is alive, but Resurge could not record ` +
            `a trustworthy process identity when it launched. It cannot prove this is a recycled PID, ` +
            `so it will not start another agent alongside it.`,
        ),
      };
    }
    if (probe.identity !== child.identity) {
      // The PID was recycled: our agent is gone, this is someone else's process.
      return { kind: 'CLEAR' };
    }
    return {
      kind: 'BLOCKED',
      reason: reviewReason(
        'LIVE_ORPHAN',
        `A previous agent process (pid ${child.pid}) from this task is still running.\n` +
          `Resurge will not start a second agent alongside it, and will not kill a process ` +
          `it no longer supervises.\n\n` +
          `Inspect it, then stop it yourself:\n  kill ${child.pid}\n` +
          `Afterwards, \`resurge resume ${task.task_id}\` will proceed.`,
      ),
    };
  }

  return {
    kind: 'BLOCKED',
    reason: reviewReason(
      'LIVE_ORPHAN',
      `Cannot determine whether the previous agent process (pid ${child.pid}) is still running: ` +
        `${probe.detail}. Resurge stops rather than risk running two agents on one repository.`,
    ),
  };
}

function isUnverifiedIdentity(identity: string): boolean {
  return identity === 'unknown' || identity.startsWith('unknown-');
}

function wasRunning(task: Task): boolean {
  return task.state === 'RUNNING' || task.state === 'STOPPING' || task.state === 'PAUSE_REQUESTED';
}
