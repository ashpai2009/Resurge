import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../helpers/home.js';
import { makeTask } from '../helpers/task.js';
import { JsonTaskStore } from '../../src/persistence/json-store.js';
import { acquireLease } from '../../src/persistence/lease.js';
import { corruptFile, resurgeHome, taskFile, tasksDir } from '../../src/persistence/paths.js';
import { parseTask, SCHEMA_VERSION } from '../../src/persistence/schema.js';
import { readFileTail, writeFileAtomic } from '../../src/persistence/fsx.js';
import { StaleTaskRevisionError } from '../../src/persistence/store.js';

let home: ReturnType<typeof useTempHome>;
beforeEach(() => {
  home = useTempHome();
});
afterEach(() => home.cleanup());

describe('save/load round-trip', () => {
  it('persists a task and reads it back identically', async () => {
    const store = new JsonTaskStore();
    const task = makeTask({ goal: 'finish the reviewer workflow' });
    const lease = await acquireLease(task.task_id);

    const saved = await store.save(lease, task);
    const loaded = store.load(task.task_id);

    expect(loaded?.ok).toBe(true);
    if (loaded?.ok) {
      expect(loaded.task.goal).toBe('finish the reviewer workflow');
      expect(loaded.task.task_id).toBe(task.task_id);
      expect(loaded.task.revision).toBe(saved.revision);
    }
    await lease.release();
  });

  it('bumps revision on every write as a stale-writer signal', async () => {
    const store = new JsonTaskStore();
    const task = makeTask();
    const lease = await acquireLease(task.task_id);

    const a = await store.save(lease, task);
    const b = await store.save(lease, a);
    expect(a.revision).toBe(1);
    expect(b.revision).toBe(2);
    await lease.release();
  });

  it('rejects a stale snapshot instead of silently losing a newer update', async () => {
    const store = new JsonTaskStore();
    const task = makeTask();
    const lease = await acquireLease(task.task_id);

    const first = await store.save(lease, task);
    await store.save(lease, { ...first, state: 'PAUSED' });

    await expect(store.save(lease, { ...first, state: 'RUNNING' })).rejects.toBeInstanceOf(
      StaleTaskRevisionError,
    );
    const loaded = store.load(task.task_id);
    expect(loaded?.ok && loaded.task.state).toBe('PAUSED');
    await lease.release();
  });

  it('survives the process: state written by one store is read by another', async () => {
    const task = makeTask({ state: 'RATE_LIMITED', resume_at: '2026-09-08T01:30:00.000Z' });
    const lease = await acquireLease(task.task_id);
    await new JsonTaskStore().save(lease, task);
    await lease.release();

    const fresh = new JsonTaskStore().load(task.task_id);
    expect(fresh?.ok).toBe(true);
    if (fresh?.ok) {
      expect(fresh.task.state).toBe('RATE_LIMITED');
      expect(fresh.task.resume_at).toBe('2026-09-08T01:30:00.000Z');
    }
  });
});

describe('bounded file tails', () => {
  it('reads only the requested final bytes from a large log', () => {
    const file = path.join(home.dir(), 'agent.log');
    fs.writeFileSync(file, '0123456789');
    expect(readFileTail(file, 4)).toEqual({ text: '6789', truncated: true });
  });
});

describe('security contract', () => {
  it('creates the home directory 0700 and task files 0600', async () => {
    const task = makeTask();
    const lease = await acquireLease(task.task_id);
    await new JsonTaskStore().save(lease, task);
    await lease.release();

    expect(fs.statSync(resurgeHome()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(tasksDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(taskFile(task.task_id)).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing overly-permissive home directory', async () => {
    fs.chmodSync(home.dir(), 0o755);
    const task = makeTask();
    const lease = await acquireLease(task.task_id);
    await new JsonTaskStore().save(lease, task);
    await lease.release();

    expect(fs.statSync(resurgeHome()).mode & 0o777).toBe(0o700);
  });

  it('refuses to write through a symlinked task file', async () => {
    const task = makeTask();
    const lease = await acquireLease(task.task_id);
    fs.mkdirSync(tasksDir(), { recursive: true });
    const elsewhere = path.join(home.dir(), 'elsewhere.json');
    fs.writeFileSync(elsewhere, '{}');
    fs.symlinkSync(elsewhere, taskFile(task.task_id));

    await expect(new JsonTaskStore().save(lease, task)).rejects.toThrow(/symlink/i);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('{}');
  });

  it('redacts secrets in every free-text field, not just the output tail', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const task = makeTask({
      goal: `use ${secret} to call the API`,
      last_output_tail: `tail saw ${secret}`,
      failure: {
        type: 'RATE_LIMIT',
        evidence: `request with ${secret} was rate limited`,
        retryable: true,
        confidence: 0.9,
        detectedAt: new Date().toISOString(),
        source: 'stderr',
      },
      review_reason: { kind: 'REPO_MISMATCH', detail: `context ${secret}` },
    });
    const lease = await acquireLease(task.task_id);
    await new JsonTaskStore().save(lease, task);
    await lease.release();

    const onDisk = fs.readFileSync(taskFile(task.task_id), 'utf8');
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain('[REDACTED]');
  });

  it('store_output=false drops the tail but keeps recovery-critical fields', async () => {
    const task = makeTask({
      store_output: false,
      last_output_tail: 'a lot of agent output',
      goal: 'still needed for recovery',
    });
    const lease = await acquireLease(task.task_id);
    await new JsonTaskStore().save(lease, task);
    await lease.release();

    const loaded = new JsonTaskStore().load(task.task_id);
    expect(loaded?.ok).toBe(true);
    if (loaded?.ok) {
      expect(loaded.task.last_output_tail).toBe('');
      expect(loaded.task.goal).toBe('still needed for recovery');
    }
  });
});

describe('corruption handling', () => {
  it('reports corruption without mutating storage', async () => {
    const id = makeTask().task_id;
    writeFileAtomic(taskFile(id), '{ this is not json');

    const before = fs.readFileSync(taskFile(id), 'utf8');
    const result = new JsonTaskStore().load(id);

    expect(result?.ok).toBe(false);
    // load() is pure: nothing renamed, nothing repaired, file byte-identical.
    expect(fs.readFileSync(taskFile(id), 'utf8')).toBe(before);
    expect(fs.existsSync(corruptFile(id))).toBe(false);
  });

  it('quarantines only under a held lease', async () => {
    const id = makeTask().task_id;
    writeFileAtomic(taskFile(id), '{ broken');
    const lease = await acquireLease(id);
    const dest = await new JsonTaskStore().quarantine(lease, id);
    await lease.release();

    expect(dest).toBe(corruptFile(id));
    expect(fs.existsSync(corruptFile(id))).toBe(true);
    expect(fs.existsSync(taskFile(id))).toBe(false);
  });

  it('refuses a record from a future schema rather than mangling it', () => {
    const future = JSON.stringify({ ...makeTask(), schema_version: SCHEMA_VERSION + 5 });
    const parsed = parseTask(future);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.futureSchema).toBe(true);
      expect(parsed.reason).toMatch(/Upgrade Resurge/);
    }
  });

  it('rejects a record with an invalid state', () => {
    const bad = JSON.stringify({ ...makeTask(), state: 'DEFINITELY_NOT_A_STATE' });
    expect(parseTask(bad).ok).toBe(false);
  });
});
