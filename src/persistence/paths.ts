import * as os from 'node:os';
import * as path from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';

/**
 * Filesystem layout. RESURGE_HOME exists so every test runs against a throwaway
 * directory and never touches the user's real state.
 *
 *   $RESURGE_HOME/
 *     tasks/<id>.json                 task record
 *     tasks/<id>.lease                exclusive lease (see persistence/lease.ts)
 *     tasks/<id>.guard                short-lived mutex around every mutation
 *     tasks/<id>.control/pending/     control requests awaiting the owner
 *     tasks/<id>.control/processing/  claimed, not yet applied (replayed on restart)
 *     cache/                          capability-probe results, keyed by version
 */
export function resurgeHome(): string {
  const override = process.env['RESURGE_HOME'];
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.resurge');
}

export function tasksDir(): string {
  return path.join(resurgeHome(), 'tasks');
}

export function cacheDir(): string {
  return path.join(resurgeHome(), 'cache');
}

export function taskFile(taskId: string): string {
  return path.join(tasksDir(), `${taskId}.json`);
}

export function corruptFile(taskId: string): string {
  return path.join(tasksDir(), `${taskId}.json.corrupt`);
}

export function leaseFile(taskId: string): string {
  return path.join(tasksDir(), `${taskId}.lease`);
}

export function deadLeaseFile(taskId: string, token: string): string {
  return path.join(tasksDir(), `${taskId}.lease.dead.${token}`);
}

export function guardFile(taskId: string): string {
  return path.join(tasksDir(), `${taskId}.guard`);
}

export function controlDir(taskId: string): string {
  return path.join(tasksDir(), `${taskId}.control`);
}

export function controlPendingDir(taskId: string): string {
  return path.join(controlDir(taskId), 'pending');
}

export function controlProcessingDir(taskId: string): string {
  return path.join(controlDir(taskId), 'processing');
}

/** Creates the home layout with owner-only permissions. */
export function ensureLayout(): void {
  for (const dir of [resurgeHome(), tasksDir(), cacheDir()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to newly created directories. Tighten an
    // existing layout too, because task goals and failure evidence are private.
    chmodSync(dir, 0o700);
  }
}

export function ensureControlDirs(taskId: string): void {
  for (const dir of [controlDir(taskId), controlPendingDir(taskId), controlProcessingDir(taskId)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

/** Task ids sort lexicographically by creation time, so `list` needs no parse. */
export function newTaskId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36).padStart(9, '0');
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `rsg_${ts}_${rand}`;
}

export function isTaskId(v: string): boolean {
  return /^rsg_[0-9a-z]+_[0-9a-z]{6}$/.test(v);
}
