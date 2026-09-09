import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ParsedArgs } from './args.js';
import {
  detachedRequestFile,
  ensureLayout,
  isTaskId,
  newTaskId,
  taskFile,
  taskLogFile,
} from '../persistence/paths.js';
import { FILE_MODE, readFileOrNull, unlinkQuiet, writeFileAtomic } from '../persistence/fsx.js';
import { probeProcess } from '../util/platform.js';
import { inspectLease } from '../persistence/lease.js';
import { JsonTaskStore } from '../persistence/json-store.js';

const wireRequestSchema = z.object({
  taskId: z.string(),
  args: z.object({
    command: z.enum(['run', 'resume']),
    positional: z.array(z.string()),
    flags: z.array(z.tuple([z.string(), z.union([z.string(), z.boolean()])])),
    rest: z.array(z.string()),
  }),
});

export interface DetachedRequest {
  taskId: string;
  args: ParsedArgs;
  logPath: string;
}

/** Starts a new supervisor process whose lifetime is independent of the terminal. */
export async function launchDetached(args: ParsedArgs): Promise<number> {
  if (args.command !== 'run' && args.command !== 'resume') {
    process.stderr.write('--detach is supported only by run and resume.\n');
    return 64;
  }

  const taskId = args.command === 'resume' ? args.positional[0] : newTaskId();
  if (!taskId || !isTaskId(taskId)) {
    process.stderr.write('A valid task id is required for detached resume.\n');
    return 64;
  }

  const before = new JsonTaskStore().load(taskId);
  const beforeRevision = before?.ok ? before.task.revision : null;

  ensureLayout();
  const logPath = taskLogFile(taskId);
  const requestPath = detachedRequestFile(taskId);
  const flags = [...args.flags.entries()].filter(([name]) => name !== 'detach');
  writeFileAtomic(
    requestPath,
    `${JSON.stringify({
      taskId,
      args: { command: args.command, positional: args.positional, flags, rest: args.rest },
    })}\n`,
  );

  let logFd: number;
  try {
    logFd = openPrivateAppend(logPath);
  } catch (err) {
    unlinkQuiet(requestPath);
    process.stderr.write(`Cannot open detached log ${logPath}: ${errorText(err)}\n`);
    return 1;
  }

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
  let child;
  try {
    child = spawn(process.execPath, [cli, '__detached', taskId], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
  } catch (err) {
    fs.closeSync(logFd);
    unlinkQuiet(requestPath);
    process.stderr.write(`Cannot start detached supervisor: ${errorText(err)}\n`);
    return 1;
  }
  fs.closeSync(logFd);

  if (child.pid === undefined) {
    unlinkQuiet(requestPath);
    process.stderr.write('Cannot start detached supervisor: no process id was assigned.\n');
    return 1;
  }
  child.unref();

  const started = await waitForSupervisor(taskId, child.pid, beforeRevision, 5_000);
  if (started === 'FAILED') {
    unlinkQuiet(requestPath);
    process.stderr.write(`Detached supervisor exited before creating task ${taskId}.\nSee: ${logPath}\n`);
    return 1;
  }

  const verb = started === 'ACTIVE' ? 'started' : 'processed';
  process.stdout.write(
    `Task ${taskId} ${verb} in the background (supervisor pid ${child.pid}).\n` +
      `Status: resurge status ${taskId}\n` +
      `Logs:   resurge logs ${taskId}\n` +
      `Pause:  resurge pause ${taskId}\n`,
  );
  return 0;
}

/** Reads and removes the private handoff consumed by an internal child process. */
export function claimDetachedRequest(taskId: string): DetachedRequest | null {
  if (!isTaskId(taskId)) return null;
  const file = detachedRequestFile(taskId);
  const raw = readFileOrNull(file);
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    unlinkQuiet(file);
    return null;
  }
  const parsed = wireRequestSchema.safeParse(json);
  if (!parsed.success || parsed.data.taskId !== taskId) {
    unlinkQuiet(file);
    return null;
  }
  unlinkQuiet(file);

  return {
    taskId,
    logPath: taskLogFile(taskId),
    args: {
      command: parsed.data.args.command,
      positional: parsed.data.args.positional,
      flags: new Map(parsed.data.args.flags),
      rest: parsed.data.args.rest,
    },
  };
}

function openPrivateAppend(file: string): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow,
    FILE_MODE,
  );
  fs.fchmodSync(fd, FILE_MODE);
  return fd;
}

async function waitForSupervisor(
  taskId: string,
  pid: number,
  beforeRevision: number | null,
  budgetMs: number,
): Promise<'ACTIVE' | 'PROCESSED' | 'FAILED'> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (
      inspectLease(taskId)?.lease.owner_pid === pid &&
      supervisorHasProgressed(taskId, beforeRevision)
    ) {
      return 'ACTIVE';
    }
    if (probeProcess(pid).kind === 'DEAD') {
      return taskChanged(taskId, beforeRevision) ? 'PROCESSED' : 'FAILED';
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (probeProcess(pid).kind !== 'DEAD') return 'ACTIVE';
  return taskChanged(taskId, beforeRevision) ? 'PROCESSED' : 'FAILED';
}

/**
 * Acquiring the lease is necessary but not a sufficient startup handshake: a
 * newly launched command first writes a WAITING_TO_RESUME record and only then
 * starts the agent. Resume similarly writes detached metadata before running
 * its gate. Waiting for the next durable transition keeps the parent from
 * announcing success during either of those small windows.
 */
function supervisorHasProgressed(taskId: string, beforeRevision: number | null): boolean {
  const loaded = new JsonTaskStore().load(taskId);
  if (!loaded?.ok) return false;
  const minimumRevision = beforeRevision === null ? 2 : beforeRevision + 2;
  return loaded.task.revision >= minimumRevision;
}

function taskChanged(taskId: string, beforeRevision: number | null): boolean {
  if (!fs.existsSync(taskFile(taskId))) return false;
  const loaded = new JsonTaskStore().load(taskId);
  if (!loaded?.ok) return false;
  return beforeRevision === null || loaded.task.revision > beforeRevision;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
