/**
 * Core task vocabulary.
 *
 * Note the deliberate split between AGENT_EXITED_SUCCESSFULLY and COMPLETED:
 * a clean process exit proves the *process* ended well, not that the *goal*
 * is done. Only a completion policy (manual confirmation or a passing verify
 * command) may write COMPLETED. See recovery/completion-policy.ts.
 */
export type TaskState =
  | 'RUNNING'
  | 'RATE_LIMITED'
  | 'NETWORK_DOWN'
  | 'AGENT_CRASHED'
  | 'PAUSE_REQUESTED'
  | 'STOPPING'
  | 'PAUSED'
  | 'WAITING_TO_RESUME'
  | 'REQUIRES_REVIEW'
  | 'AGENT_EXITED_SUCCESSFULLY'
  | 'COMPLETED'
  | 'UNKNOWN_FAILURE';

export const TASK_STATES: readonly TaskState[] = [
  'RUNNING',
  'RATE_LIMITED',
  'NETWORK_DOWN',
  'AGENT_CRASHED',
  'PAUSE_REQUESTED',
  'STOPPING',
  'PAUSED',
  'WAITING_TO_RESUME',
  'REQUIRES_REVIEW',
  'AGENT_EXITED_SUCCESSFULLY',
  'COMPLETED',
  'UNKNOWN_FAILURE',
] as const;

/**
 * Why a task is parked in REQUIRES_REVIEW.
 *
 * `forceable` is the whole point of this being a typed union rather than a
 * string: `resurge resume --force` may override a judgement call, but must
 * never override a blocker whose violation would put two agents on one
 * repository. See recovery/review-reason.ts for the forceable table.
 */
export type ReviewReasonKind =
  // Forceable — the user can inspect the situation and accept it.
  | 'REPO_MISMATCH'
  | 'MISSING_INTERRUPTION_SNAPSHOT'
  | 'REPEATED_CRASHES'
  | 'VERIFY_COMMAND_FAILED'
  | 'UNCLASSIFIED_FAILURE'
  // Not forceable — duplicate-process or integrity risk.
  | 'LIVE_ORPHAN'
  | 'ACTIVE_OWNER'
  | 'UNKILLABLE_CHILD'
  | 'OWNER_UNRESPONSIVE'
  | 'STALE_GUARD'
  | 'CORRUPT_STATE'
  | 'UNKNOWN_FUTURE_SCHEMA'
  | 'UNSUPPORTED_PLATFORM';

export interface ReviewReason {
  kind: ReviewReasonKind;
  /** Human-readable explanation, shown verbatim by `resurge status`. */
  detail: string;
}

/** Identity of a supervised child, enough to prove liveness across a restart. */
export interface ChildIdentity {
  pid: number;
  pgid: number;
  /** Process start time, so PID reuse cannot masquerade as the same child. */
  identity: string;
  started_at: string;
}

export interface TaskAttempts {
  crash: number;
  total_resumes: number;
}

export interface Task {
  schema_version: number;
  task_id: string;
  agent: string;
  goal: string;
  session_id: string | null;
  /** Exact launch directory, including when it is not a Git repository. */
  workdir?: string;
  /** Whether the task was launched as a background supervisor. */
  detached?: boolean;
  /** Private per-task supervisor/agent log for detached runs. */
  log_path?: string | null;

  /** Provenance only. NEVER an input to the pre-resume gate. */
  repo_at_start: RepoSnapshotRef | null;
  /** The recovery baseline: captured immediately after the child exits. */
  repo_at_interruption: RepoSnapshotRef | null;

  state: TaskState;
  failure: FailureEventRef | null;
  review_reason: ReviewReason | null;
  resume_at: string | null;

  child: ChildIdentity | null;
  attempts: TaskAttempts;

  /** Bounded, redacted tail of recent agent output. */
  last_output_tail: string;
  /** Verify command as an argv vector; no shell is ever involved. */
  verify_argv: string[] | null;
  store_output: boolean;

  /** Compared under the lease guard to reject stale snapshots. */
  revision: number;
  created_at: string;
  updated_at: string;
}

// Structural refs, kept loose here to avoid a circular import with repo.ts /
// failure.ts; the zod schema in persistence/schema.ts is the real contract.
export interface RepoSnapshotRef {
  root: string | null;
  branch: string | null;
  head_sha: string | null;
  entries: { x: string; y: string; path: string; origPath?: string; content_hash?: string }[];
  captured_at: string;
  unavailable_reason?: string;
}

export interface FailureEventRef {
  type: string;
  evidence: string;
  retryable: boolean;
  retryAfter?: string;
  confidence: number;
  detectedAt: string;
  source: string;
}
