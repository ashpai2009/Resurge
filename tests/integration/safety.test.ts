import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { useTempHome } from '../helpers/home.js';
import { makeTask } from '../helpers/task.js';
import { TempRepo } from '../helpers/git.js';
import { ScriptedAdapter } from '../helpers/scripted-agent.js';
import { isAlive } from '../helpers/child.js';
import { JsonTaskStore } from '../../src/persistence/json-store.js';
import { acquireLease, type LeaseHandle } from '../../src/persistence/lease.js';
import { Supervisor } from '../../src/supervisor/supervisor.js';
import { DEFAULT_POLICY } from '../../src/supervisor/policy.js';
import { alwaysOnline } from '../../src/network/connectivity.js';
import { captureSnapshot } from '../../src/repo/snapshot.js';
import { reconcileOrphan } from '../../src/supervisor/orphan.js';
import { isForceable } from '../../src/recovery/review-reason.js';
import { claimRequests, requestControl, settleRequest } from '../../src/persistence/control.js';
import { controlPendingDir, controlProcessingDir } from '../../src/persistence/paths.js';
import { processIdentity } from '../../src/util/platform.js';
import { FakeClock } from '../../src/util/clock.js';
import { instantSleeper } from '../../src/util/sleep.js';
import type { ReviewReasonKind, Task } from '../../src/types/task.js';
import * as fs from 'node:fs';
import { pauseCommand } from '../../src/cli/commands/pause.js';

let home: ReturnType<typeof useTempHome>;
let repo: TempRepo;
let store: JsonTaskStore;
let lease: LeaseHandle;
const spawned: ChildProcess[] = [];

beforeEach(() => {
  home = useTempHome();
  repo = new TempRepo();
  store = new JsonTaskStore();
});
afterEach(async () => {
  for (const p of spawned.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await lease?.release().catch(() => {});
  repo.cleanup();
  home.cleanup();
});

async function seed(overrides: Partial<Task> = {}): Promise<Task> {
  const task = makeTask({ agent: 'scripted', ...overrides });
  lease = await acquireLease(task.task_id);
  return store.save(lease, { ...task, repo_at_start: await captureSnapshot(repo.dir) });
}

function longLivedProcess(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  spawned.push(p);
  return p;
}

describe('orphan reconciliation', () => {
  it('blocks and leaves a live orphan running rather than killing it', async () => {
    const orphan = longLivedProcess();
    const task = await seed({
      state: 'RUNNING',
      child: {
        pid: orphan.pid!,
        pgid: orphan.pid!,
        identity: processIdentity(orphan.pid!)!,
        started_at: new Date().toISOString(),
      },
    });

    const adapter = new ScriptedAdapter([{ exit: { code: 0, signal: null } }]);
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const final = await new Supervisor(task, {
      adapter,
      store,
      lease,
      network: alwaysOnline,
      clock,
      sleeper: instantSleeper(clock),
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    }).run();

    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('LIVE_ORPHAN');
    expect(final.review_reason?.detail).toContain(String(orphan.pid));
    // No second agent was started, and the orphan was not killed.
    expect(adapter.launches).toHaveLength(0);
    expect(isAlive(orphan.pid!)).toBe(true);
  });

  it('proceeds when the previous child is provably dead', async () => {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise((r) => dead.on('exit', r));

    const task = await seed({
      state: 'RUNNING',
      child: {
        pid: dead.pid!,
        pgid: dead.pid!,
        identity: 'whatever it was',
        started_at: new Date().toISOString(),
      },
    });
    expect(reconcileOrphan(task).kind).toBe('CLEAR');
  });

  it('proceeds when the PID was recycled by an unrelated process', () => {
    const other = longLivedProcess();
    const task = makeTask({
      state: 'RUNNING',
      child: {
        pid: other.pid!,
        pgid: other.pid!,
        // A start time that is not this process's: the PID was reused.
        identity: 'Thu Jan  1 00:00:00 1970',
        started_at: new Date().toISOString(),
      },
    });
    expect(reconcileOrphan(task).kind).toBe('CLEAR');
  });

  it('blocks when the child is alive but its original identity was unavailable', () => {
    const child = longLivedProcess();
    const task = makeTask({
      state: 'RUNNING',
      child: {
        pid: child.pid!,
        pgid: child.pid!,
        identity: `unknown-${child.pid}@launch`,
        started_at: new Date().toISOString(),
      },
    });
    expect(reconcileOrphan(task).kind).toBe('BLOCKED');
  });
});

describe('pause never lies about the agent', () => {
  it('does not persist PAUSED until the process has actually exited', async () => {
    const writes: string[] = [];
    const original = store.save.bind(store);
    store.save = async (l, t) => {
      writes.push(t.state);
      return original(l, t);
    };

    let exitProcess: () => void = () => {};
    // wait() hands back one shared promise, as the AgentProcess contract
    // requires: the supervisor and the stop routine both await it.
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      exitProcess = () => resolve({ code: null, signal: 'SIGTERM' });
    });
    const adapter = new ScriptedAdapter([{ exit: { code: 0, signal: null } }]);
    adapter.start = async () => ({
      pid: 4242,
      pgid: 4242,
      startedAt: new Date().toISOString(),
      onStdout: () => {},
      onStderr: () => {},
      wait: () => exited,
      kill: () => {
        // A real agent takes a moment to die; PAUSED must not be written yet.
        setTimeout(() => exitProcess(), 20);
      },
    });

    const task = await seed();
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const sup = new Supervisor(task, {
      adapter,
      store,
      lease,
      network: alwaysOnline,
      clock,
      sleeper: instantSleeper(clock),
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    });

    const running = sup.run();
    await new Promise((r) => setTimeout(r, 50));
    await sup.requestPause();
    const final = await running;

    expect(final.state).toBe('PAUSED');
    // The confirmed-stop ordering: request, then stopping, then paused.
    expect(writes).toContain('PAUSE_REQUESTED');
    expect(writes).toContain('STOPPING');
    expect(writes.indexOf('PAUSE_REQUESTED')).toBeLessThan(writes.indexOf('STOPPING'));
    expect(writes.indexOf('STOPPING')).toBeLessThan(writes.lastIndexOf('PAUSED'));
  });

  it('does not mark a live orphan PAUSED after its supervisor lease is gone', async () => {
    const orphan = longLivedProcess();
    const task = await seed({
      state: 'RUNNING',
      child: {
        pid: orphan.pid!,
        pgid: orphan.pid!,
        identity: processIdentity(orphan.pid!)!,
        started_at: new Date().toISOString(),
      },
    });
    await lease.release();

    expect(await pauseCommand(task.task_id)).toBe(1);
    const loaded = store.load(task.task_id);
    expect(loaded?.ok && loaded.task.state).toBe('REQUIRES_REVIEW');
    expect(loaded?.ok && loaded.task.review_reason?.kind).toBe('LIVE_ORPHAN');
    expect(isAlive(orphan.pid!)).toBe(true);
  });

  it('honors a pause that arrives while the adapter is still launching', async () => {
    let finishLaunch: (process: Awaited<ReturnType<ScriptedAdapter['start']>>) => void = () => {};
    let finishExit: () => void = () => {};
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      finishExit = () => resolve({ code: null, signal: 'SIGTERM' });
    });
    const adapter = new ScriptedAdapter([{ exit: { code: 0, signal: null } }]);
    adapter.start = () =>
      new Promise((resolve) => {
        finishLaunch = resolve;
      });

    const task = await seed();
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const sup = new Supervisor(task, {
      adapter,
      store,
      lease,
      network: alwaysOnline,
      clock,
      sleeper: instantSleeper(clock),
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    });

    const running = sup.run();
    await Promise.resolve();
    const pausing = sup.requestPause();
    await Promise.resolve();
    finishLaunch({
      pid: 4243,
      pgid: 4243,
      startedAt: new Date().toISOString(),
      onStdout: () => {},
      onStderr: () => {},
      wait: () => exited,
      kill: () => finishExit(),
    });

    await pausing;
    const final = await running;
    expect(final.state).toBe('PAUSED');
  });
});

describe('control requests keep the lease invariant', () => {
  it('is claimed, applied, then settled - and replayed if never settled', async () => {
    const task = await seed();
    requestControl(task.task_id, 'pause');

    expect(fs.readdirSync(controlPendingDir(task.task_id))).toHaveLength(1);

    const claimed = claimRequests(task.task_id);
    expect(claimed).toHaveLength(1);
    // Claiming moves it to processing/ rather than deleting it, so a crash
    // before the state write replays the request instead of losing it.
    expect(fs.readdirSync(controlPendingDir(task.task_id))).toHaveLength(0);
    expect(fs.readdirSync(controlProcessingDir(task.task_id))).toHaveLength(1);

    // Simulate a crash here: a new supervisor must see the request again.
    expect(claimRequests(task.task_id)).toHaveLength(1);

    settleRequest(claimed[0]!);
    expect(claimRequests(task.task_id)).toHaveLength(0);
  });

  it('does not silently discard a valid request just because it is old', async () => {
    const task = await seed();
    const file = requestControl(task.task_id, 'pause');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    old.requested_at = new Date(Date.now() - 48 * 3600_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(old));

    expect(claimRequests(task.task_id)).toHaveLength(1);
  });
});

describe('--force cannot override a duplicate-agent risk', () => {
  const forceable: ReviewReasonKind[] = [
    'REPO_MISMATCH',
    'MISSING_INTERRUPTION_SNAPSHOT',
    'REPEATED_CRASHES',
    'VERIFY_COMMAND_FAILED',
    'UNCLASSIFIED_FAILURE',
  ];
  const unforceable: ReviewReasonKind[] = [
    'LIVE_ORPHAN',
    'ACTIVE_OWNER',
    'UNKILLABLE_CHILD',
    'OWNER_UNRESPONSIVE',
    'STALE_GUARD',
    'CORRUPT_STATE',
    'UNKNOWN_FUTURE_SCHEMA',
    'UNSUPPORTED_PLATFORM',
  ];

  for (const kind of forceable) {
    it(`allows --force past ${kind}`, () => {
      expect(isForceable({ kind, detail: '' })).toBe(true);
    });
  }
  for (const kind of unforceable) {
    it(`refuses --force past ${kind}`, () => {
      expect(isForceable({ kind, detail: '' })).toBe(false);
    });
  }

  it('still runs orphan reconciliation under --force', async () => {
    const orphan = longLivedProcess();
    const task = await seed({
      state: 'RUNNING',
      review_reason: { kind: 'REPO_MISMATCH', detail: 'forceable' },
      child: {
        pid: orphan.pid!,
        pgid: orphan.pid!,
        identity: processIdentity(orphan.pid!)!,
        started_at: new Date().toISOString(),
      },
    });

    const adapter = new ScriptedAdapter([{ exit: { code: 0, signal: null } }]);
    const clock = new FakeClock('2026-09-08T20:00:00Z');
    const final = await new Supervisor(task, {
      adapter,
      store,
      lease,
      network: alwaysOnline,
      clock,
      sleeper: instantSleeper(clock),
      policy: { ...DEFAULT_POLICY, heartbeatMs: 60_000 },
      cwd: repo.dir,
    }).run({ force: true, resuming: true });

    // --force suppresses the forceable finding but never skips the gate, so
    // the live orphan discovered during the rerun still stops the resume.
    expect(final.state).toBe('REQUIRES_REVIEW');
    expect(final.review_reason?.kind).toBe('LIVE_ORPHAN');
    expect(adapter.launches).toHaveLength(0);
  });
});
