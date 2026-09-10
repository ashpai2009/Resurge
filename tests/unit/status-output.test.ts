import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { statusCommand } from '../../src/cli/commands/status.js';
import { ensureLayout, taskFile } from '../../src/persistence/paths.js';
import { serializeTask } from '../../src/persistence/schema.js';
import { makeTask } from '../helpers/task.js';
import { useTempHome } from '../helpers/home.js';

const homes: ReturnType<typeof useTempHome>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) home.cleanup();
});

describe('status failure history', () => {
  it('labels an earlier crash as previous after the task is running again', () => {
    const home = useTempHome();
    homes.push(home);
    const task = makeTask({
      state: 'RUNNING',
      failure: {
        type: 'AGENT_CRASH',
        evidence: 'agent exited with code 2',
        retryable: true,
        confidence: 1,
        detectedAt: new Date().toISOString(),
        source: 'exit',
      },
    });
    ensureLayout();
    fs.writeFileSync(taskFile(task.task_id), serializeTask(task));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    expect(statusCommand(task.task_id)).toBe(0);
    expect(output).toContain('Previous failure');
    expect(output).not.toMatch(/\nFailure\n/);
  });
});
