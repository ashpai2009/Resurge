/**
 * Exclusive per-task lease.
 *
 * The lease is the primary serialization mechanism in Resurge. Task.revision
 * is also compared inside the same guard to reject stale in-process snapshots;
 * doing that check outside the guard would not be atomic.
 */
export interface Lease {
  task_id: string;
  /** 128-bit random, regenerated on every acquisition. The fencing token. */
  token: string;
  /** Monotonic; increments by exactly one per takeover. */
  generation: number;
  owner_pid: number;
  /** Process start time; distinguishes a live owner from PID reuse. */
  owner_identity: string;
  hostname: string;
  /** Changes across reboot, invalidating every pre-reboot lease. */
  boot_id: string;
  acquired_at: string;
  /** Refreshed every few seconds. Used for REPORTING only, never takeover. */
  heartbeat_at: string;
}

export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class LeaseUnavailableError extends Error {
  readonly reviewKind: 'ACTIVE_OWNER' | 'OWNER_UNRESPONSIVE' | 'STALE_GUARD';
  constructor(
    message: string,
    reviewKind: 'ACTIVE_OWNER' | 'OWNER_UNRESPONSIVE' | 'STALE_GUARD',
  ) {
    super(message);
    this.name = 'LeaseUnavailableError';
    this.reviewKind = reviewKind;
  }
}
