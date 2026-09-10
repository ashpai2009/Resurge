import type { LoadResult } from '../persistence/store.js';

export interface TaskCatalog {
  list(): LoadResult[];
}

/** Resolve the explicit `latest` alias without hiding unreadable newest state. */
export function resolveTaskSelector(catalog: TaskCatalog, selector: string): string | null {
  if (selector !== 'latest') return selector;
  const newest = catalog.list().at(-1);
  if (!newest) return null;
  return newest.ok ? newest.task.task_id : newest.taskId;
}
