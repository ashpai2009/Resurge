import { SCHEMA_VERSION } from './schema.js';

/**
 * Ordered migrations applied on load, oldest first.
 *
 * v0.1 ships with only v1, so this is empty. It exists now because retrofitting
 * a migration path onto records already on disk is much harder than carrying an
 * empty registry. A record whose version is *higher* than SCHEMA_VERSION is
 * refused in schema.ts rather than migrated backwards.
 */
export type Migration = {
  from: number;
  to: number;
  migrate(record: Record<string, unknown>): Record<string, unknown>;
};

export const migrations: Migration[] = [];

export function applyMigrations(record: Record<string, unknown>): Record<string, unknown> {
  let current = record;
  let version = typeof current['schema_version'] === 'number' ? (current['schema_version'] as number) : 1;

  for (;;) {
    if (version >= SCHEMA_VERSION) break;
    const step = migrations.find((m) => m.from === version);
    if (!step) break;
    current = step.migrate(current);
    current['schema_version'] = step.to;
    version = step.to;
  }
  return current;
}
