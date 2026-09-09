import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Gives a test its own RESURGE_HOME so nothing ever touches the user's real
 * ~/.resurge, and so suites cannot see each other's tasks.
 */
export function useTempHome(): { dir: () => string; cleanup: () => void } {
  const prev = process.env['RESURGE_HOME'];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'resurge-test-'));
  process.env['RESURGE_HOME'] = dir;

  return {
    dir: () => dir,
    cleanup: () => {
      if (prev === undefined) delete process.env['RESURGE_HOME'];
      else process.env['RESURGE_HOME'] = prev;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
