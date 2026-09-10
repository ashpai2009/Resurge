import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { statusCommand } from '../../src/cli/commands/status.js';
import { listCommand } from '../../src/cli/commands/list.js';
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

describe('task history', () => {
  it('shows start time, end or ongoing status, and each available log path', () => {
    const home = useTempHome();
    homes.push(home);
    const running = makeTask({
      state: 'RUNNING',
      goal: 'inspect the architecture',
      log_path: '/tmp/running.log',
      created_at: '2026-09-09T10:00:00.000Z',
      updated_at: '2026-09-09T10:05:00.000Z',
    });
    const complete = makeTask({
      state: 'COMPLETED',
      goal: 'finish the migration',
      log_path: '/tmp/complete.log',
      created_at: '2026-09-08T10:00:00.000Z',
      updated_at: '2026-09-08T11:30:00.000Z',
    });
    ensureLayout();
    fs.writeFileSync(taskFile(running.task_id), serializeTask(running));
    fs.writeFileSync(taskFile(complete.task_id), serializeTask(complete));
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    expect(listCommand()).toBe(0);
    expect(output).toContain('STARTED');
    expect(output).toContain('ENDED');
    expect(output).toContain('ongoing');
    expect(output).toContain('/tmp/running.log');
    expect(output).toContain('/tmp/complete.log');
    expect(output).toContain('inspect the architecture');
    expect(output).toContain('finish the migration');
  });
});
