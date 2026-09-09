/** Tunable limits, in one place so they can be reasoned about together. */
export interface Policy {
  /** Automatic restarts after a crash, before escalating to a human. */
  maxCrashRetries: number;
  /**
   * A process that ran cleanly for at least this long has "proved itself":
   * its crash counter resets. Without this, a task that crashes twice in its
   * first minute is permanently poisoned three hours later.
   */
  crashCounterResetMs: number;
  /** Safety margin added to a parsed rate-limit reset time. */
  rateLimitMarginMs: number;
  /** Backoff ladder when no reset time could be parsed. */
  rateLimitBackoffMs: number[];
  /** Pause between crash restarts. */
  crashBackoffMs: number[];
  /** Bounded budget for the advisory network probe. */
  networkBudgetMs: number;
  /** Grace period between SIGTERM and SIGKILL when stopping an agent. */
  stopGraceMs: number;
  /** How often the run loop beats and checks for control requests. */
  heartbeatMs: number;
  /** Cap on the retained output tail. */
  outputTailBytes: number;
}

export const DEFAULT_POLICY: Policy = {
  maxCrashRetries: 3,
  crashCounterResetMs: 60_000,
  rateLimitMarginMs: 60_000,
  rateLimitBackoffMs: [5 * 60_000, 15 * 60_000, 45 * 60_000, 2 * 60 * 60_000],
  crashBackoffMs: [2_000, 10_000, 30_000],
  networkBudgetMs: 15 * 60_000,
  stopGraceMs: 10_000,
  heartbeatMs: 5_000,
  outputTailBytes: 64 * 1024,
};

export function backoffAt(ladder: number[], attempt: number): number {
  if (ladder.length === 0) return 0;
  const idx = Math.min(attempt, ladder.length - 1);
  return ladder[idx]!;
}
