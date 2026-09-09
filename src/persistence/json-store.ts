import * as fs from 'node:fs';
import type { Task } from '../types/task.js';
import { StaleTaskRevisionError, type LoadResult, type TaskStore } from './store.js';
import type { LeaseHandle } from './lease.js';
import { parseTask, serializeTask, SCHEMA_VERSION } from './schema.js';
import { applyMigrations } from './migrations.js';
import { readFileOrNull, writeFileAtomic } from './fsx.js';
import { corruptFile, ensureLayout, isTaskId, taskFile, tasksDir } from './paths.js';

export class JsonTaskStore implements TaskStore {
  load(taskId: string): LoadResult | null {
    const raw = readFileOrNull(taskFile(taskId));
    if (raw === null) return null;

    // Migrations run on the parsed object before validation, so an older record
    // is upgraded in memory. Nothing is written back here: load() is pure.
    let candidate = raw;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const version = typeof obj['schema_version'] === 'number' ? obj['schema_version'] : 1;
      if (version < SCHEMA_VERSION) candidate = JSON.stringify(applyMigrations(obj));
    } catch {
      /* fall through to parseTask, which reports the JSON error properly */
    }

    const parsed = parseTask(candidate);
    if (parsed.ok) return { ok: true, task: parsed.task };
    return { ok: false, taskId, reason: parsed.reason, futureSchema: parsed.futureSchema };
  }

  list(): LoadResult[] {
    ensureLayout();
    let names: string[];
    try {
      names = fs.readdirSync(tasksDir());
    } catch {
      return [];
    }
    const ids = names
      .filter((n) => n.endsWith('.json') && !n.endsWith('.corrupt'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter(isTaskId)
      .sort();

    const out: LoadResult[] = [];
    for (const id of ids) {
      const r = this.load(id);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Writes under the lease guard. The on-disk revision is checked inside that
   * same critical section, so two callers sharing a valid lease cannot silently
   * overwrite one another with stale snapshots.
   */
  async save(lease: LeaseHandle, task: Task): Promise<Task> {
    if (lease.taskId !== task.task_id) {
      throw new Error(`lease for ${lease.taskId} cannot write task ${task.task_id}`);
    }
    return lease.withGuard(() => {
      const current = this.load(task.task_id);
      if (current && !current.ok) {
        throw new Error(`refusing to overwrite unreadable task ${task.task_id}: ${current.reason}`);
      }
      if (current?.ok && current.task.revision !== task.revision) {
        throw new StaleTaskRevisionError(task.task_id, task.revision, current.task.revision);
      }
      const next: Task = {
        ...task,
        schema_version: SCHEMA_VERSION,
        revision: task.revision + 1,
        updated_at: new Date().toISOString(),
      };
      ensureLayout();
      writeFileAtomic(taskFile(next.task_id), serializeTask(next));
      return next;
    });
  }

  async quarantine(lease: LeaseHandle, taskId: string): Promise<string> {
    return lease.withGuard(() => {
      const dest = corruptFile(taskId);
      fs.renameSync(taskFile(taskId), dest);
      return dest;
    });
  }
}
