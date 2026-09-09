import { z } from 'zod';
import { TASK_STATES } from '../types/task.js';
import type { Task } from '../types/task.js';
import { redact } from '../util/redact.js';

export const SCHEMA_VERSION = 1;

const porcelainEntry = z.object({
  x: z.string(),
  y: z.string(),
  path: z.string(),
  origPath: z.string().optional(),
  content_hash: z.string().optional(),
});

const repoSnapshot = z.object({
  root: z.string().nullable(),
  branch: z.string().nullable(),
  head_sha: z.string().nullable(),
  entries: z.array(porcelainEntry),
  captured_at: z.string(),
  unavailable_reason: z.string().optional(),
});

const failureEvent = z.object({
  type: z.string(),
  evidence: z.string(),
  retryable: z.boolean(),
  retryAfter: z.string().optional(),
  confidence: z.number(),
  detectedAt: z.string(),
  source: z.string(),
});

const reviewReason = z.object({
  kind: z.enum([
    'REPO_MISMATCH',
    'MISSING_INTERRUPTION_SNAPSHOT',
    'REPEATED_CRASHES',
    'VERIFY_COMMAND_FAILED',
    'UNCLASSIFIED_FAILURE',
    'LIVE_ORPHAN',
    'ACTIVE_OWNER',
    'UNKILLABLE_CHILD',
    'OWNER_UNRESPONSIVE',
    'STALE_GUARD',
    'CORRUPT_STATE',
    'UNKNOWN_FUTURE_SCHEMA',
    'UNSUPPORTED_PLATFORM',
  ]),
  detail: z.string(),
});

const childIdentity = z.object({
  pid: z.number(),
  pgid: z.number(),
  identity: z.string(),
  started_at: z.string(),
});

export const taskSchema = z.object({
  schema_version: z.number().int().positive(),
  task_id: z.string().min(1),
  agent: z.string().min(1),
  goal: z.string(),
  session_id: z.string().nullable(),
  workdir: z.string().optional(),
  repo_at_start: repoSnapshot.nullable(),
  repo_at_interruption: repoSnapshot.nullable(),
  state: z.enum(TASK_STATES as unknown as [string, ...string[]]),
  failure: failureEvent.nullable(),
  review_reason: reviewReason.nullable(),
  resume_at: z.string().nullable(),
  child: childIdentity.nullable(),
  attempts: z.object({
    crash: z.number().int().nonnegative(),
    total_resumes: z.number().int().nonnegative(),
  }),
  last_output_tail: z.string(),
  verify_argv: z.array(z.string()).nullable(),
  store_output: z.boolean(),
  revision: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Every free-text field that gets persisted, in one place.
 *
 * Redaction is applied here at the storage layer rather than at call sites,
 * because a call-site convention is exactly the kind of thing that gets
 * bypassed: an earlier design redacted the output tail but wrote failure
 * evidence verbatim. No caller chooses any more.
 */
export function redactTask(task: Task): Task {
  const out: Task = {
    ...task,
    goal: redact(task.goal),
    last_output_tail: task.store_output ? redact(task.last_output_tail) : '',
    failure: task.failure
      ? { ...task.failure, evidence: redact(task.failure.evidence) }
      : null,
    review_reason: task.review_reason
      ? { ...task.review_reason, detail: redact(task.review_reason.detail) }
      : null,
  };
  return out;
}

export type ParseResult =
  | { ok: true; task: Task }
  | { ok: false; reason: string; futureSchema: boolean };

/**
 * Parses a stored record. Never mutates anything on disk: `resurge status` must
 * be able to report corruption without two concurrent invocations fighting over
 * a damaged file. Quarantine is a separate, lease-held operation.
 */
export function parseTask(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not valid JSON: ${(err as Error).message}`, futureSchema: false };
  }

  const version = (json as { schema_version?: unknown })?.schema_version;
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `record uses schema v${version}, this Resurge understands v${SCHEMA_VERSION}. Upgrade Resurge rather than risk corrupting newer data.`,
      futureSchema: true,
    };
  }

  const parsed = taskSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; '),
      futureSchema: false,
    };
  }
  return { ok: true, task: parsed.data as Task };
}

export function serializeTask(task: Task): string {
  return `${JSON.stringify(redactTask(task), null, 2)}\n`;
}
