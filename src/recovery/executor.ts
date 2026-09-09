import type { Task } from '../types/task.js';
import type { AgentAdapter } from '../types/agent.js';
import type { NetworkChecker } from '../network/connectivity.js';
import { captureSnapshot } from '../repo/snapshot.js';
import { verifyRepo } from '../repo/verifier.js';
import { reviewReason } from './review-reason.js';
import type { ReviewReason } from '../types/task.js';
import type { Clock } from '../util/clock.js';
import { logger } from '../util/logger.js';

export type GateResult =
  | { kind: 'PROCEED'; current: Awaited<ReturnType<typeof captureSnapshot>> }
  | { kind: 'BLOCKED'; reason: ReviewReason };

export interface GateOptions {
  /**
   * Suppresses only *forceable* findings. It never skips a step: the gate still
   * runs in full, and a non-forceable blocker discovered here still stops the
   * resume. See recovery/review-reason.ts.
   */
  force: boolean;
  cwd: string;
}

/**
 * The single pre-resume gate.
 *
 * Every recovery path — rate limit, network, crash restart, manual resume —
 * funnels through here, so the safety checks cannot be accidentally skipped by
 * one code path. Order matters: cheap local checks before anything that costs
 * time or quota.
 */
export async function preResumeGate(
  task: Task,
  adapter: AgentAdapter,
  network: NetworkChecker,
  options: GateOptions,
  clock: Clock,
  networkBudgetMs: number,
): Promise<GateResult> {
  // 1. Repository verification, against the interruption baseline. Keep all
  //    cheap local blockers ahead of a connectivity wait that may take minutes.
  const current = await captureSnapshot(options.cwd, clock);
  const verdict = verifyRepo(task.repo_at_interruption, current);
  if (verdict.kind === 'REQUIRES_REVIEW') {
    const kind = task.repo_at_interruption === null ? 'MISSING_INTERRUPTION_SNAPSHOT' : 'REPO_MISMATCH';
    const reason = reviewReason(kind, verdict.reasons.join('\n\n'));
    if (!options.force) return { kind: 'BLOCKED', reason };
    logger.warn(`--force: proceeding despite ${kind}`);
  }

  // 2. The agent is installed and the argv we build actually parses. Not a
  //    health check — it proves nothing about auth or API availability.
  const install = await adapter.installationCheck();
  if (!install.ok) {
    return {
      kind: 'BLOCKED',
      // Not forceable via REPO_MISMATCH: without a working binary there is
      // nothing to resume into, so this is a hard stop regardless of --force.
      reason: reviewReason('CORRUPT_STATE', `agent is not usable: ${install.detail}`),
    };
  }

  // 3. Connectivity — advisory and bounded. Never terminal: if the budget
  //    expires we go on and let a real invocation produce real evidence.
  const online = await network.waitForConnectivity(networkBudgetMs);
  if (!online) {
    logger.warn('proceeding without confirmed connectivity (probe is advisory)');
  }

  return { kind: 'PROCEED', current };
}
