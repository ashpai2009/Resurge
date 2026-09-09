import type { ReviewReason, ReviewReasonKind } from '../types/task.js';

/**
 * Which review reasons `resurge resume --force` may override.
 *
 * The unforceable set is exactly the set where proceeding could put two agents
 * on one repository, or where the state we would resume from is untrustworthy.
 * A user can reasonably say "yes, I looked at the diff, go on"; no user input
 * makes it safe to launch a second Codex alongside a live one.
 */
const FORCEABLE: Record<ReviewReasonKind, boolean> = {
  REPO_MISMATCH: true,
  MISSING_INTERRUPTION_SNAPSHOT: true,
  REPEATED_CRASHES: true,
  VERIFY_COMMAND_FAILED: true,
  UNCLASSIFIED_FAILURE: true,

  LIVE_ORPHAN: false,
  ACTIVE_OWNER: false,
  UNKILLABLE_CHILD: false,
  OWNER_UNRESPONSIVE: false,
  STALE_GUARD: false,
  CORRUPT_STATE: false,
  UNKNOWN_FUTURE_SCHEMA: false,
  UNSUPPORTED_PLATFORM: false,
};

export function isForceable(reason: ReviewReason | null): boolean {
  if (!reason) return true;
  return FORCEABLE[reason.kind];
}

export function reviewReason(kind: ReviewReasonKind, detail: string): ReviewReason {
  return { kind, detail };
}

export function explainUnforceable(reason: ReviewReason): string {
  const why: Partial<Record<ReviewReasonKind, string>> = {
    LIVE_ORPHAN: 'a previous agent process is still running; resuming would run two agents on one repository',
    ACTIVE_OWNER: 'another Resurge supervisor already owns this task',
    UNKILLABLE_CHILD: 'the previous agent process could not be stopped',
    OWNER_UNRESPONSIVE: 'the previous supervisor is alive but unresponsive, so its agent may still be running',
    STALE_GUARD: 'a state update was interrupted, so the stored state may be inconsistent',
    CORRUPT_STATE: 'the stored task state could not be read',
    UNKNOWN_FUTURE_SCHEMA: 'the stored state was written by a newer version of Resurge',
    UNSUPPORTED_PLATFORM: 'this platform does not provide the guarantees Resurge relies on',
  };
  return why[reason.kind] ?? reason.detail;
}
