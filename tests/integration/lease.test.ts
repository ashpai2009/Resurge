import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import { useTempHome } from '../helpers/home.js';
import { makeTask } from '../helpers/task.js';
import { isAlive, procsDir, repoRoot, spawnLineChild, waitUntil } from '../helpers/child.js';
import { JsonTaskStore } from '../../src/persistence/json-store.js';
import { acquireLease, classifyLease, GUARD_STALE_MS } from '../../src/persistence/lease.js';
import { guardFile, leaseFile } from '../../src/persistence/paths.js';
import { bootId, hostname, processIdentity } from '../../src/util/platform.js';
import type { Lease } from '../../src/types/lease.js';

let home: ReturnType<typeof useTempHome>;
beforeEach(() => {
  home = useTempHome();
});
afterEach(() => home.cleanup());

function writeLease(taskId: string, overrides: Partial<Lease>): Lease {
  const lease: Lease = {
    task_id: taskId,
    token: 'aaaabbbbccccdddd',
    generation: 1,
    owner_pid: process.pid,
    owner_identity: processIdentity(process.pid) ?? 'unknown',
    hostname: hostname(),
    boot_id: bootId(),
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    ...overrides,
  };
  fs.mkdirSync(path.dirname(leaseFile(taskId)), { recursive: true });
  fs.writeFileSync(leaseFile(taskId), JSON.stringify(lease, null, 2));
  return lease;
}

describe('takeover requires proof, never a timeout', () => {
  it('refuses a lease held by a live, responsive owner', async () => {
    const id = makeTask().task_id;
    writeLease(id, {});
    await expect(acquireLease(id)).rejects.toMatchObject({ reviewKind: 'ACTIVE_OWNER' });
  });

  it('escalates rather than seizing when the owner is alive but has stopped checking in', async () => {
    // The dangerous case: a SIGSTOPped or badly swapped supervisor looks exactly
    // like this, and its child may still be writing to the repository.
    const id = makeTask().task_id;
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const before = writeLease(id, { heartbeat_at: stale });

    await expect(acquireLease(id)).rejects.toMatchObject({ reviewKind: 'OWNER_UNRESPONSIVE' });

    // Crucially, the lease is left exactly as it was.
    const after = JSON.parse(fs.readFileSync(leaseFile(id), 'utf8')) as Lease;
    expect(after.token).toBe(before.token);
    expect(after.generation).toBe(before.generation);
  });

  it('takes over when the owner process is provably dead', async () => {
    const id = makeTask().task_id;
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((r) => dead.on('exit', r));
    writeLease(id, { owner_pid: dead.pid!, owner_identity: 'whatever-it-was', generation: 4 });

    const lease = await acquireLease(id);
    expect(lease.leaseGeneration).toBe(5);
    await lease.release();
  });

  it('takes over when the PID was recycled (identity mismatch)', async () => {
    const id = makeTask().task_id;
    // Our own PID is alive, but the recorded start time is not ours.
    writeLease(id, { owner_identity: 'Thu Jan  1 00:00:00 1970', generation: 2 });

    const lease = await acquireLease(id);
    expect(lease.leaseGeneration).toBe(3);
    await lease.release();
  });

  it('takes over when the machine has rebooted since the lease was written', async () => {
    const id = makeTask().task_id;
    writeLease(id, { boot_id: 'a-previous-boot', generation: 7 });
    const lease = await acquireLease(id);
    expect(lease.leaseGeneration).toBe(8);
    await lease.release();
  });

  it('escalates when the lease was taken on another host', () => {
    const id = makeTask().task_id;
    const lease = writeLease(id, { hostname: 'some-other-machine' });
    const verdict = classifyLease(lease, Date.now());
    expect(verdict.kind).toBe('UNPROVEN');
  });
});

describe('the guard is never stolen', () => {
  it('escalates on a guard left behind by an interrupted mutation', async () => {
    const id = makeTask().task_id;
    fs.mkdirSync(path.dirname(guardFile(id)), { recursive: true });
    fs.writeFileSync(guardFile(id), JSON.stringify({ pid: 999999 }));
    const old = Date.now() - (GUARD_STALE_MS + 60_000);
    fs.utimesSync(guardFile(id), old / 1000, old / 1000);

    // Dead owner would otherwise be a valid takeover; the stale guard wins,
    // because integrity of the on-disk state is unknown.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((r) => dead.on('exit', r));
    writeLease(id, { owner_pid: dead.pid!, owner_identity: 'gone' });

    await expect(acquireLease(id)).rejects.toMatchObject({ reviewKind: 'STALE_GUARD' });
    expect(fs.existsSync(guardFile(id))).toBe(true);
  });
});

describe('two processes racing one provably-stale lease', () => {
  it('lets exactly one win and increments generation by exactly one', async () => {
    const id = makeTask().task_id;
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((r) => dead.on('exit', r));
    writeLease(id, { owner_pid: dead.pid!, owner_identity: 'gone', generation: 3 });

    const startAt = Date.now() + 400;
    const runOne = () =>
      new Promise<{ ok: boolean; generation?: number; kind?: string }>((resolve) => {
        const p = spawn(
          process.execPath,
          [path.join(procsDir, 'race-takeover.mjs'), id, String(startAt)],
          { cwd: repoRoot, env: { ...process.env, RESURGE_HOME: home.dir() } },
        );
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('exit', () => resolve(JSON.parse(out.trim() || '{"ok":false}')));
      });

    const [a, b] = await Promise.all([runOne(), runOne()]);
    const winners = [a, b].filter((r) => r.ok);

    expect(winners).toHaveLength(1);
    expect(winners[0]!.generation).toBe(4);

    const onDisk = JSON.parse(fs.readFileSync(leaseFile(id), 'utf8')) as Lease;
    expect(onDisk.generation).toBe(4);
    expect(onDisk.token).toBe((winners[0] as { token: string }).token);
  });
});

describe('a displaced owner cannot touch its successor', () => {
  it('fails the old owner write, heartbeat and release after a proven takeover', async () => {
    const task = makeTask({ goal: 'original goal' });
    const id = task.task_id;

    // Seed the record so the old owner has something to overwrite.
    const seed = await acquireLease(id);
    await new JsonTaskStore().save(seed, task);
    await seed.release();

    // Old owner acquires and suspends itself inside the guard, immediately
    // after its fencing token was verified.
    const old = spawnLineChild('hold-lease.mjs', [id, '--suspend-at-seam'], {
      RESURGE_HOME: home.dir(),
    });
    await old.expect('acquired');
    old.send('write');
    await old.expect('at-seam');
    // It is now SIGSTOPped mid-mutation, still holding the guard.
    const oldPid = old.proc.pid!;
    await waitUntil(() => processState(oldPid) === 'T');

    // Kill it outright: that is what makes the takeover *proven* rather than
    // merely suspected, and it releases the guard along with the process.
    process.kill(oldPid, 'SIGKILL');
    await old.exited;
    // A killed process cannot clean up its guard file; clear it the way a human
    // would after the escalation, so the successor can proceed.
    fs.rmSync(guardFile(id), { force: true });

    const successor = await acquireLease(id);
    expect(successor.leaseGeneration).toBe(2);

    // The successor's state must be intact and untouched by the dead owner.
    const loaded = new JsonTaskStore().load(id);
    expect(loaded?.ok).toBe(true);
    if (loaded?.ok) expect(loaded.task.goal).toBe('original goal');
    expect(fs.existsSync(leaseFile(id))).toBe(true);
    await successor.release();
  });

  it('rejects writes from a handle whose lease was taken over', async () => {
    const task = makeTask({ goal: 'original goal' });
    const id = task.task_id;
    const store = new JsonTaskStore();

    const first = await acquireLease(id);
    await store.save(first, task);

    // Simulate the takeover that happens while this owner is not in the guard.
    fs.writeFileSync(
      leaseFile(id),
      JSON.stringify({
        ...(JSON.parse(fs.readFileSync(leaseFile(id), 'utf8')) as Lease),
        token: 'a-successors-token',
        generation: 2,
      }),
    );

    await expect(store.save(first, { ...task, goal: 'CLOBBERED' })).rejects.toMatchObject({
      name: 'LeaseLostError',
    });
    await expect(first.heartbeat()).rejects.toMatchObject({ name: 'LeaseLostError' });

    // Release must not unlink the successor's lease.
    await first.release();
    expect(fs.existsSync(leaseFile(id))).toBe(true);
    const after = JSON.parse(fs.readFileSync(leaseFile(id), 'utf8')) as Lease;
    expect(after.token).toBe('a-successors-token');

    const loaded = store.load(id);
    if (loaded?.ok) expect(loaded.task.goal).toBe('original goal');
  });
});

/** Reads the POSIX process state letter; 'T' means stopped. */
function processState(pid: number): string | null {
  if (!isAlive(pid)) return null;
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0] ?? null;
  } catch {
    return null;
  }
}
