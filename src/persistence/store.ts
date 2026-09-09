import type { Task } from '../types/task.js';
import type { LeaseHandle } from './lease.js';

export type LoadResult =
  | { ok: true; task: Task }
  | { ok: false; taskId: string; reason: string; futureSchema: boolean };

export class StaleTaskRevisionError extends Error {
  constructor(taskId: string, expected: number, actual: number) {
    super(`stale task write for ${taskId}: record is revision ${actual}, writer has revision ${expected}`);
    this.name = 'StaleTaskRevisionError';
  }
}

/**
 * Persistence boundary. JSON-on-disk is the v0.1 implementation; SQLite could
 * replace it without the supervisor noticing.
 *
 * Note that every mutating call takes a LeaseHandle. That is the type system
 * enforcing the core invariant: only the lease owner writes task state.
 */
export interface TaskStore {
  /** Pure read. Never mutates storage, even for a corrupt record. */
  load(taskId: string): LoadResult | null;
  list(): LoadResult[];
  save(lease: LeaseHandle, task: Task): Promise<Task>;
  /** Moves a corrupt record aside. Requires the lease. */
  quarantine(lease: LeaseHandle, taskId: string): Promise<string>;
}
