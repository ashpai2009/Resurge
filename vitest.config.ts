import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Source uses NodeNext-style ".js" specifiers (required for real ESM output).
 * Tests import the TypeScript directly, so relative ".js" specifiers are
 * remapped to the ".ts" file when one exists.
 */
const tsResolver = {
  name: 'resurge-js-to-ts',
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = path.resolve(path.dirname(importer), source.slice(0, -3) + '.ts');
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [tsResolver],
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // Lease and guard tests spawn real processes and manipulate real files;
    // each file gets its own RESURGE_HOME, but they must not share one.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
