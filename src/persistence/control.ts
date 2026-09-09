import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ControlRequest } from '../types/control.js';
import { createExclusive, readFileOrNull, renameIfExists, unlinkQuiet } from './fsx.js';
import { controlPendingDir, controlProcessingDir, ensureControlDirs } from './paths.js';
import { logger } from '../util/logger.js';

const requestSchema = z.object({
  kind: z.literal('pause'),
  requested_at: z.string(),
  requested_by_pid: z.number(),
});

/**
 * Files a request for the lease owner to act on.
 *
 * A process that does not hold the lease must never write task state, so
 * `resurge pause` against a live task lands here instead of touching the
 * record. The unique filename makes O_EXCL creation sufficient; no lock needed.
 */
export function requestControl(taskId: string, kind: 'pause'): string {
  ensureControlDirs(taskId);
  const req: ControlRequest = {
    kind,
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  };
  const name = `${Date.now()}-${randomUUID()}.json`;
  const target = path.join(controlPendingDir(taskId), name);
  if (!createExclusive(target, `${JSON.stringify(req, null, 2)}\n`)) {
    throw new Error(`failed to file control request for ${taskId}`);
  }
  return target;
}

export interface ClaimedRequest {
  request: ControlRequest;
  /** Path in processing/; call `settle` only once the transition has landed. */
  file: string;
}

/**
 * Claims outstanding requests: replays anything left in processing/ first, then
 * moves pending/ entries across.
 *
 * The pending -> processing -> delete lifecycle makes consumption at-least-once.
 * Deleting on claim would be at-most-once, and a crash between the delete and
 * the state write would silently lose a pause the user asked for. Transitions
 * are idempotent, so a replayed pause on an already-paused task is a no-op.
 */
export function claimRequests(taskId: string, _nowMs = Date.now()): ClaimedRequest[] {
  ensureControlDirs(taskId);
  const out: ClaimedRequest[] = [];

  // 1. Replay: a previous supervisor died mid-apply.
  for (const file of listDir(controlProcessingDir(taskId))) {
    const req = readRequest(file);
    if (req) out.push({ request: req, file });
    else unlinkQuiet(file);
  }

  // 2. Claim new ones.
  for (const file of listDir(controlPendingDir(taskId))) {
    const dest = path.join(controlProcessingDir(taskId), path.basename(file));
    if (!renameIfExists(file, dest)) continue;
    const req = readRequest(dest);
    if (req) out.push({ request: req, file: dest });
    else unlinkQuiet(dest);
  }

  return out;
}

/** Removes a request. Call only after the resulting state write has landed. */
export function settleRequest(claimed: ClaimedRequest): void {
  unlinkQuiet(claimed.file);
}

export function pendingCount(taskId: string): number {
  return listDir(controlPendingDir(taskId)).length + listDir(controlProcessingDir(taskId)).length;
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function readRequest(file: string): ControlRequest | null {
  const raw = readFileOrNull(file);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(`ignoring unparseable control request ${file}`);
    return null;
  }
  const result = requestSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(`ignoring invalid control request ${file}`);
    return null;
  }
  return result.data;
}
