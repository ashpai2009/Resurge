import { randomBytes } from 'node:crypto';
import { LeaseLostError, LeaseUnavailableError } from '../types/lease.js';
import type { Lease } from '../types/lease.js';
import { bootId, hostname, probeProcess, processIdentity } from '../util/platform.js';
import { createExclusive, readFileOrNull, renameIfExists, statMtimeMs, unlinkQuiet, writeFileAtomic } from './fsx.js';
import { deadLeaseFile, ensureLayout, guardFile, leaseFile } from './paths.js';
import { logger } from '../util/logger.js';

/** A guard held longer than this means something died mid-mutation. */
export const GUARD_STALE_MS = 60_000;
/** Heartbeat age past which an owner is *reported* unresponsive. */
export const HEARTBEAT_STALE_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Test seam. Fires inside the guard, after the fencing token has been verified
 * and before the mutation runs — the exact window a displaced owner would try
 * to exploit. Tests suspend a process here to prove the guard closes it.
 */
export let __afterTokenVerify: (() => Promise<void>) | null = null;
export function __setAfterTokenVerify(fn: (() => Promise<void>) | null): void {
  __afterTokenVerify = fn;
}

type Staleness =
  | { kind: 'PROVEN'; why: string }
  | { kind: 'ACTIVE'; why: string }
  | { kind: 'UNPROVEN'; why: string };

/**
 * Decides whether an existing lease may be seized.
 *
 * Takeover requires PROOF that the old owner is gone: the process is dead, the
 * PID was recycled, or the machine rebooted. A stale heartbeat is deliberately
 * NOT proof — a SIGSTOPped or heavily swapped supervisor produces one while its
 * child runs happily, and seizing there would put two agents on one repository.
 * Every timeout in Resurge escalates to a human; none of them seize a resource.
 */
export function classifyLease(lease: Lease, nowMs: number): Staleness {
  if (lease.boot_id !== bootId()) {
    return { kind: 'PROVEN', why: 'machine rebooted since the lease was taken' };
  }
  if (lease.hostname !== hostname()) {
    return {
      kind: 'UNPROVEN',
      why: `lease was taken on host ${lease.hostname}; liveness cannot be checked from here`,
    };
  }

  const probe = probeProcess(lease.owner_pid);
  if (probe.kind === 'DEAD') {
    return { kind: 'PROVEN', why: `owner pid ${lease.owner_pid} is gone` };
  }
  if (probe.kind === 'UNKNOWN') {
    return { kind: 'UNPROVEN', why: probe.detail };
  }
  if (lease.owner_identity === 'unknown' || lease.owner_identity.startsWith('unknown-')) {
    return {
      kind: 'UNPROVEN',
      why: `owner pid ${lease.owner_pid} is alive, but its original process identity was unavailable`,
    };
  }
  if (probe.identity !== lease.owner_identity) {
    return {
      kind: 'PROVEN',
      why: `pid ${lease.owner_pid} was recycled (start time differs from the lease)`,
    };
  }

  const age = nowMs - Date.parse(lease.heartbeat_at);
  if (Number.isFinite(age) && age > HEARTBEAT_STALE_MS) {
    return {
      kind: 'UNPROVEN',
      why: `owner pid ${lease.owner_pid} is alive but has not checked in for ${Math.round(age / 1000)}s`,
    };
  }
  return { kind: 'ACTIVE', why: `task is supervised by pid ${lease.owner_pid}` };
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * The guard: one short-lived mutex covering takeover AND every mutation.
 *
 * Verifying a fencing token outside a mutex leaves the very race the token is
 * meant to close — an owner can verify, be suspended, lose the lease, wake, and
 * overwrite its successor. Token check and mutation must be one critical
 * section, so they both live in here.
 */
async function acquireGuard(taskId: string): Promise<void> {
  const file = guardFile(taskId);
  const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });

  for (;;) {
    if (createExclusive(file, payload)) return;

    const mtime = statMtimeMs(file);
    if (mtime === null) continue; // vanished between attempts; retry immediately

    const age = Date.now() - mtime;
    if (age > GUARD_STALE_MS) {
      // Never steal a guard: doing so would reintroduce the recursion this
      // design exists to avoid, and a guard held for a minute means a mutation
      // was interrupted, so on-disk integrity is unknown.
      throw new LeaseUnavailableError(
        `a state mutation for ${taskId} was interrupted ${Math.round(age / 1000)}s ago and never completed`,
        'STALE_GUARD',
      );
    }
    // Guards are held for milliseconds; jitter avoids two waiters resonating.
    await delay(10 + Math.floor(Math.random() * 40));
  }
}

function releaseGuard(taskId: string): void {
  unlinkQuiet(guardFile(taskId));
}

function readLease(taskId: string): Lease | null {
  const raw = readFileOrNull(leaseFile(taskId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Lease;
  } catch {
    return null;
  }
}

/**
 * A held lease. Every mutation the holder performs goes through `withGuard`,
 * which re-verifies the fencing token under the guard first.
 */
export class LeaseHandle {
  readonly taskId: string;
  private token: string;
  private generation: number;
  private released = false;

  constructor(taskId: string, token: string, generation: number) {
    this.taskId = taskId;
    this.token = token;
    this.generation = generation;
  }

  get fencingToken(): string {
    return this.token;
  }

  get leaseGeneration(): number {
    return this.generation;
  }

  /**
   * Runs `fn` with the guard held and this handle's token confirmed current.
   * Throws LeaseLostError if the lease has moved on — a displaced owner can
   * therefore neither write task state, refresh a heartbeat, nor release the
   * lease that now belongs to its successor.
   */
  async withGuard<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.released) {
      throw new LeaseLostError(`lease for ${this.taskId} was already released`);
    }
    await acquireGuard(this.taskId);
    try {
      const current = readLease(this.taskId);
      if (current === null || current.token !== this.token) {
        throw new LeaseLostError(
          `lease for ${this.taskId} is no longer held by this process` +
            (current ? ` (now generation ${current.generation})` : ' (lease file is gone)'),
        );
      }
      if (__afterTokenVerify) await __afterTokenVerify();
      return await fn();
    } finally {
      releaseGuard(this.taskId);
    }
  }

  async heartbeat(): Promise<void> {
    await this.withGuard(() => {
      const current = readLease(this.taskId);
      if (!current) throw new LeaseLostError(`lease for ${this.taskId} vanished`);
      const next: Lease = { ...current, heartbeat_at: new Date().toISOString() };
      writeFileAtomic(leaseFile(this.taskId), `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  /** Releases only if we still hold it; never unlinks a successor's lease. */
  async release(): Promise<void> {
    if (this.released) return;
    try {
      await this.withGuard(() => {
        unlinkQuiet(leaseFile(this.taskId));
      });
    } catch (err) {
      if (err instanceof LeaseLostError) {
        logger.debug(`release skipped: ${err.message}`);
      } else {
        throw err;
      }
    } finally {
      this.released = true;
    }
  }

  /** Marks the handle dead without touching disk (used after LeaseLostError). */
  abandon(): void {
    this.released = true;
  }
}

function mintLease(taskId: string, generation: number): Lease {
  const identity = processIdentity(process.pid);
  return {
    task_id: taskId,
    token: randomBytes(16).toString('hex'),
    generation,
    owner_pid: process.pid,
    owner_identity: identity ?? `unknown-${process.pid}`,
    hostname: hostname(),
    boot_id: bootId(),
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  };
}

/**
 * Acquires the exclusive lease for a task.
 *
 * Throws LeaseUnavailableError, carrying the review reason the caller should
 * record, when the lease is held or its status cannot be proven.
 */
export async function acquireLease(taskId: string): Promise<LeaseHandle> {
  ensureLayout();

  // Fast path: no lease file at all.
  const fresh = mintLease(taskId, 1);
  if (createExclusive(leaseFile(taskId), `${JSON.stringify(fresh, null, 2)}\n`)) {
    return new LeaseHandle(taskId, fresh.token, fresh.generation);
  }

  const existing = readLease(taskId);
  if (existing === null) {
    // The file exists but is unreadable/garbled. We cannot prove anything about
    // it, and integrity is suspect, so a human decides.
    throw new LeaseUnavailableError(
      `the lease file for ${taskId} is unreadable; task state integrity is unknown`,
      'STALE_GUARD',
    );
  }

  const verdict = classifyLease(existing, Date.now());
  if (verdict.kind === 'ACTIVE') {
    throw new LeaseUnavailableError(verdict.why, 'ACTIVE_OWNER');
  }
  if (verdict.kind === 'UNPROVEN') {
    throw new LeaseUnavailableError(verdict.why, 'OWNER_UNRESPONSIVE');
  }

  return takeover(taskId, existing, verdict.why);
}

/**
 * Fenced takeover. O_EXCL can create a missing lease but cannot replace an
 * existing one, and unlink-then-create races: two stealers can have the second
 * delete the first's freshly written lease. So the swap happens under the guard,
 * and step 2's token recheck means a stealer that slept through another's whole
 * takeover aborts instead of clobbering a live successor.
 */
async function takeover(taskId: string, observed: Lease, why: string): Promise<LeaseHandle> {
  await acquireGuard(taskId);
  try {
    const current = readLease(taskId);
    if (current === null) {
      // Someone completed a takeover and released; restart cleanly.
      throw new LeaseUnavailableError(
        `lease for ${taskId} changed while taking over; retry`,
        'OWNER_UNRESPONSIVE',
      );
    }
    if (current.token !== observed.token) {
      throw new LeaseUnavailableError(
        `lease for ${taskId} was taken over by another process while we were deciding`,
        'ACTIVE_OWNER',
      );
    }
    const recheck = classifyLease(current, Date.now());
    if (recheck.kind !== 'PROVEN') {
      throw new LeaseUnavailableError(recheck.why, recheck.kind === 'ACTIVE' ? 'ACTIVE_OWNER' : 'OWNER_UNRESPONSIVE');
    }

    renameIfExists(leaseFile(taskId), deadLeaseFile(taskId, observed.token));
    const next = mintLease(taskId, observed.generation + 1);
    if (!createExclusive(leaseFile(taskId), `${JSON.stringify(next, null, 2)}\n`)) {
      throw new LeaseUnavailableError(
        `failed to install a new lease for ${taskId}`,
        'STALE_GUARD',
      );
    }
    logger.info(`took over lease for ${taskId} (generation ${next.generation}): ${why}`);
    return new LeaseHandle(taskId, next.token, next.generation);
  } finally {
    releaseGuard(taskId);
  }
}

/** Read-only view for `status`/`list`, which must not disturb anything. */
export function inspectLease(taskId: string): { lease: Lease; verdict: Staleness } | null {
  const lease = readLease(taskId);
  if (!lease) return null;
  return { lease, verdict: classifyLease(lease, Date.now()) };
}
