import type { FailureEvent } from '../types/failure.js';
import type { Task, TaskState } from '../types/task.js';
import { backoffAt, type Policy } from '../supervisor/policy.js';

/**
 * What to do about a failure. Deciding is separate from doing: this is a pure
 * function, so the whole decision table is testable without processes, files or
 * clocks, and a detection rule can never reach in and restart something.
 */
export type RecoveryAction =
  | { kind: 'WAIT_UNTIL'; until: Date; state: TaskState; why: string }
  | { kind: 'WAIT_BACKOFF'; ms: number; state: TaskState; why: string }
  | { kind: 'WAIT_FOR_NETWORK'; budgetMs: number; state: TaskState; why: string }
  | { kind: 'RESTART'; delayMs: number; state: TaskState; why: string }
  | { kind: 'START_FRESH'; why: string }
  | { kind: 'ESCALATE'; why: string; reason: 'REPEATED_CRASHES' | 'UNCLASSIFIED_FAILURE' };

export function planRecovery(
  task: Task,
  event: FailureEvent,
  policy: Policy,
): RecoveryAction {
  switch (event.type) {
    case 'SESSION_INVALID':
      // The only failure that justifies abandoning a session. Everything else
      // keeps session_id so the agent's accumulated context is not thrown away.
      return {
        kind: 'START_FRESH',
        why: 'the stored session no longer exists, so a fresh one is started with a full continuation prompt',
      };

    case 'RATE_LIMIT': {
      if (event.retryAfter) {
        // A margin, because waking at the exact advertised second tends to hit
        // the limit again on a boundary.
        const until = new Date(Date.parse(event.retryAfter) + policy.rateLimitMarginMs);
        return {
          kind: 'WAIT_UNTIL',
          until,
          state: 'RATE_LIMITED',
          why: `rate limited; waiting until ${until.toISOString()} (reset time plus a safety margin)`,
        };
      }
      const ms = backoffAt(policy.rateLimitBackoffMs, task.attempts.total_resumes);
      return {
        kind: 'WAIT_BACKOFF',
        ms,
        state: 'RATE_LIMITED',
        why: `rate limited with no parseable reset time; backing off ${Math.round(ms / 60_000)} minutes`,
      };
    }

    case 'NETWORK_DOWN':
      return {
        kind: 'WAIT_FOR_NETWORK',
        budgetMs: policy.networkBudgetMs,
        state: 'NETWORK_DOWN',
        why: 'network failure; waiting for connectivity to return',
      };

    case 'AGENT_CRASH': {
      // attempts.crash counts crashes; maxCrashRetries counts automatic
      // RESTARTS. The first crash earns restart 1, so the budget is exhausted
      // only once the crash count exceeds it.
      const restartsUsed = task.attempts.crash - 1;
      if (restartsUsed >= policy.maxCrashRetries) {
        return {
          kind: 'ESCALATE',
          reason: 'REPEATED_CRASHES',
          why:
            `the agent crashed ${task.attempts.crash} times; ` +
            `all ${policy.maxCrashRetries} automatic restarts are used up`,
        };
      }
      const delayMs = backoffAt(policy.crashBackoffMs, restartsUsed);
      return {
        kind: 'RESTART',
        delayMs,
        state: 'AGENT_CRASHED',
        why: `agent crashed; automatic restart ${restartsUsed + 1} of ${policy.maxCrashRetries}`,
      };
    }

    case 'UNKNOWN_FAILURE':
    default:
      // Retrying something we cannot explain is a guess, and Resurge escalates
      // rather than guessing.
      return {
        kind: 'ESCALATE',
        reason: 'UNCLASSIFIED_FAILURE',
        why: `the agent failed in a way Resurge could not classify: ${event.evidence}`,
      };
  }
}
