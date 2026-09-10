import { describe, expect, it } from 'vitest';
import { resolveTaskSelector } from '../../src/cli/task-selector.js';
import type { LoadResult } from '../../src/persistence/store.js';
import { makeTask } from '../helpers/task.js';

describe('task selectors', () => {
  it('resolves latest to the newest task returned by the catalog', () => {
    const older = makeTask({ task_id: 'rsg_000000001_aaaaaa' });
    const newer = makeTask({ task_id: 'rsg_000000002_bbbbbb' });
    const catalog = { list: (): LoadResult[] => [{ ok: true, task: older }, { ok: true, task: newer }] };

    expect(resolveTaskSelector(catalog, 'latest')).toBe(newer.task_id);
    expect(resolveTaskSelector(catalog, older.task_id)).toBe(older.task_id);
  });

  it('returns null when latest is requested before any task exists', () => {
    expect(resolveTaskSelector({ list: () => [] }, 'latest')).toBeNull();
  });
});
