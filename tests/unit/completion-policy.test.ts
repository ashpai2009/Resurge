import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateCompletion } from '../../src/recovery/completion-policy.js';
import { makeTask } from '../helpers/task.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('completion verification', () => {
  it('runs in the exact workdir for a non-Git project', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurge-verify-'));
    dirs.push(workdir);
    const task = makeTask({
      workdir,
      repo_at_start: null,
      repo_at_interruption: null,
      verify_argv: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync('verified-from-workdir.txt', 'ok')`,
      ],
    });

    expect((await evaluateCompletion(task)).kind).toBe('COMPLETED');
    expect(fs.readFileSync(path.join(workdir, 'verified-from-workdir.txt'), 'utf8')).toBe('ok');
  });
});
