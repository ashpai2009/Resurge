import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../helpers/home.js';
import { TempRepo } from '../helpers/git.js';
import { isAlive, repoRoot, waitUntil } from '../helpers/child.js';
import { JsonTaskStore } from '../../src/persistence/json-store.js';
import { detachedRequestFile } from '../../src/persistence/paths.js';

const exec = promisify(execFile);
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');

let home: ReturnType<typeof useTempHome>;
let repo: TempRepo;
const supervisors: number[] = [];

beforeEach(() => {
  home = useTempHome();
  repo = new TempRepo();
});

afterEach(() => {
  for (const pid of supervisors.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
  }
  repo.cleanup();
  home.cleanup();
});

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return exec(process.execPath, [CLI, ...args], {
    cwd: repo.dir,
    env: { ...process.env, RESURGE_HOME: home.dir(), NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function ids(stdout: string): { taskId: string; pid: number } {
  const match = /Task (rsg_[0-9a-z]+_[0-9a-z]{6}).*supervisor pid (\d+)/.exec(stdout);
  if (!match) throw new Error(`detached launch did not report task and pid:\n${stdout}`);
  return { taskId: match[1]!, pid: Number(match[2]) };
}

function state(taskId: string): string | null {
  const loaded = new JsonTaskStore().load(taskId);
  return loaded?.ok ? loaded.task.state : null;
}

describe('detached supervision', () => {
  it('outlives the launching CLI and writes a durable per-task log', async () => {
    const privateGoal = 'background demo private-goal-7f31';
    const launch = await cli(
      ['run', 'fake', privateGoal, '--scenario', 'delayed', '--detach'],
      { FAKE_DELAY_MS: '2000' },
    );
    const { taskId, pid } = ids(launch.stdout);
    supervisors.push(pid);

    expect(launch.stdout).toContain(`resurge logs ${taskId}`);
    const processList = await exec('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    expect(processList.stdout).not.toContain(privateGoal);
    expect(fs.existsSync(detachedRequestFile(taskId))).toBe(false);
    expect(state(taskId)).toBe('RUNNING');
    await waitUntil(() => state(taskId) === 'AGENT_EXITED_SUCCESSFULLY', 10_000);
    const logs = await cli(['logs', taskId]);
    expect(logs.stdout).toContain('working...');
    expect(logs.stdout).toContain('State AGENT_EXITED_SUCCESSFULLY');

    const status = await cli(['status', taskId]);
    expect(status.stdout).toContain('Mode');
    expect(status.stdout).toContain('detached');
  });

  it('keeps supervising through crash backoff after the parent CLI exits', async () => {
    const counter = path.join(home.dir(), 'detached-crash-counter');
    const launch = await cli(
      ['run', 'fake', 'background recovery', '--scenario', 'crash-then-success', '--detach'],
      { FAKE_COUNTER_FILE: counter },
    );
    const { taskId, pid } = ids(launch.stdout);
    supervisors.push(pid);

    await waitUntil(() => state(taskId) === 'AGENT_EXITED_SUCCESSFULLY', 20_000);
    const loaded = new JsonTaskStore().load(taskId);
    expect(loaded?.ok && loaded.task.attempts.total_resumes).toBe(2);
  }, 25_000);

  it('can be paused safely from another CLI process', async () => {
    const launch = await cli(
      ['run', 'fake', 'background pause', '--scenario', 'delayed', '--detach'],
      { FAKE_DELAY_MS: '120000' },
    );
    const { taskId, pid } = ids(launch.stdout);
    supervisors.push(pid);
    await waitUntil(() => state(taskId) === 'RUNNING');

    const paused = await cli(['pause', taskId]);
    expect(paused.stdout).toContain('Pause requested');
    await waitUntil(() => state(taskId) === 'PAUSED', 15_000);
    await waitUntil(() => !isAlive(pid), 5_000);

    const resumed = await cli(['resume', taskId, '--scenario', 'success', '--detach']);
    const resumedProcess = ids(resumed.stdout);
    supervisors.push(resumedProcess.pid);
    expect(resumedProcess.taskId).toBe(taskId);
    await waitUntil(() => state(taskId) === 'AGENT_EXITED_SUCCESSFULLY', 10_000);
    const loaded = new JsonTaskStore().load(taskId);
    expect(loaded?.ok && loaded.task.attempts.total_resumes).toBe(1);
  }, 25_000);
});
