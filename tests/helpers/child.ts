import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const procsDir = path.resolve(here, '..', 'procs');
export const repoRoot = path.resolve(here, '..', '..');

export interface LineChild {
  proc: ChildProcessWithoutNullStreams;
  /** Waits for the next line whose `event` matches. */
  expect(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  send(cmd: string): void;
  lines: Record<string, unknown>[];
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export function spawnLineChild(script: string, args: string[], env: Record<string, string>): LineChild {
  const proc = spawn(process.execPath, [path.join(procsDir, script), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const lines: Record<string, unknown>[] = [];
  const waiters: { event: string; resolve: (v: Record<string, unknown>) => void }[] = [];
  let buf = '';

  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!raw) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      lines.push(obj);
      const idx = waiters.findIndex((w) => w.event === obj['event']);
      if (idx !== -1) waiters.splice(idx, 1)[0]!.resolve(obj);
    }
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    proc,
    lines,
    exited,
    send: (cmd: string) => proc.stdin.write(`${cmd}\n`),
    expect(event: string, timeoutMs = 10_000) {
      const already = lines.find((l) => l['event'] === event);
      if (already) return Promise.resolve(already);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${event}"; saw ${JSON.stringify(lines)}`)),
          timeoutMs,
        );
        waiters.push({
          event,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
      });
    },
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitUntil timed out');
}
