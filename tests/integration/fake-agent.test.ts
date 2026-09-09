import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { useTempHome } from '../helpers/home.js';
import { TempRepo } from '../helpers/git.js';
import { repoRoot } from '../helpers/child.js';

const exec = promisify(execFile);
const CLI = path.join(repoRoot, 'dist', 'cli', 'index.js');

let home: ReturnType<typeof useTempHome>;
let repo: TempRepo;

beforeEach(() => {
  home = useTempHome();
  repo = new TempRepo();
});
afterEach(() => {
  repo.cleanup();
  home.cleanup();
});

async function resurge(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: repo.dir,
      env: { ...process.env, RESURGE_HOME: home.dir(), NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function taskIdFrom(stdout: string): string {
  const m = /task (rsg_[0-9a-z]+_[0-9a-z]{6})/.exec(stdout);
  if (!m) throw new Error(`no task id in output:\n${stdout}`);
  return m[1]!;
}

describe('end to end against the fake agent, using real processes', () => {
  it('runs a task to a clean exit and requires explicit completion', async () => {
    const run = await resurge(['run', 'fake', 'demo task', '--scenario', 'success']);
    expect(run.stdout).toContain('AGENT_EXITED_SUCCESSFULLY');
    const id = taskIdFrom(run.stdout);

    const status = await resurge(['status', id]);
    expect(status.stdout).toContain('AGENT_EXITED_SUCCESSFULLY');

    const done = await resurge(['complete', id]);
    expect(done.stdout).toContain('marked complete');
    expect((await resurge(['status', id])).stdout).toContain('COMPLETED');
  });

  it('refuses to complete a task whose agent has not exited cleanly', async () => {
    // --max-crash-retries 0 escalates on the first crash, so the test does not
    // sit through the real 2s/10s/30s restart backoff.
    const run = await resurge(['run', 'fake', 'crashy', '--scenario', 'crash', '--max-crash-retries', '0']);
    const id = taskIdFrom(run.stdout);
    const res = await resurge(['complete', id]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/not AGENT_EXITED_SUCCESSFULLY/);
  });

  it('does not misclassify alarming text that the agent merely printed', async () => {
    // stdout mentions 429, ECONNRESET and "usage limit reached", then exits 0.
    const run = await resurge(['run', 'fake', 'noisy', '--scenario', 'noisy-stdout']);
    expect(run.stdout).toContain('AGENT_EXITED_SUCCESSFULLY');
    expect(run.stdout).not.toContain('RATE_LIMITED');
    expect(run.stdout).not.toContain('NETWORK_DOWN');
  });

  it('never adopts a bare UUID as a session id', async () => {
    const run = await resurge(['run', 'fake', 'uuidy', '--scenario', 'bare-uuid']);
    const id = taskIdFrom(run.stdout);
    const raw = JSON.parse(fs.readFileSync(path.join(home.dir(), 'tasks', `${id}.json`), 'utf8'));
    expect(raw.session_id).toBeNull();
  });

  it('reassembles a session id from JSONL split across chunk boundaries', async () => {
    const run = await resurge(['run', 'fake', 'split', '--scenario', 'split-jsonl']);
    const id = taskIdFrom(run.stdout);
    const raw = JSON.parse(fs.readFileSync(path.join(home.dir(), 'tasks', `${id}.json`), 'utf8'));
    expect(raw.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('classifies a signal death as a crash', async () => {
    const run = await resurge(['run', 'fake', 'segv', '--scenario', 'segfault', '--max-crash-retries', '0']);
    const id = taskIdFrom(run.stdout);
    const raw = JSON.parse(fs.readFileSync(path.join(home.dir(), 'tasks', `${id}.json`), 'utf8'));
    expect(raw.failure.type).toBe('AGENT_CRASH');
    expect(raw.state).toBe('REQUIRES_REVIEW');
  });

  it('recovers after transient crashes and reaches a clean exit', async () => {
    // The fake agent fails twice, then succeeds, tracked via a counter file.
    // Two restarts cost 2s + 10s of real backoff.
    const run = await resurge(['run', 'fake', 'flaky', '--scenario', 'crash-then-success'], {
      FAKE_COUNTER_FILE: path.join(home.dir(), 'counter'),
    });
    expect(run.stdout).toContain('AGENT_EXITED_SUCCESSFULLY');

    const id = taskIdFrom(run.stdout);
    const raw = JSON.parse(fs.readFileSync(path.join(home.dir(), 'tasks', `${id}.json`), 'utf8'));
    expect(raw.attempts.total_resumes).toBe(2);
  }, 60_000);

  it('records a rate limit with a parsed reset time and stops there', async () => {
    // maxCrashRetries does not apply; the run would otherwise sleep for hours,
    // so this asserts the persisted state rather than waiting it out.
    const proc = execFile(
      process.execPath,
      [CLI, 'run', 'fake', 'limited', '--scenario', 'rate-limit'],
      { cwd: repo.dir, env: { ...process.env, RESURGE_HOME: home.dir(), NO_COLOR: '1' } },
    );
    let out = '';
    proc.stdout?.on('data', (d) => (out += d.toString()));

    await new Promise((r) => setTimeout(r, 3000));
    proc.kill('SIGKILL');

    const id = taskIdFrom(out);
    const raw = JSON.parse(fs.readFileSync(path.join(home.dir(), 'tasks', `${id}.json`), 'utf8'));
    expect(raw.state).toBe('RATE_LIMITED');
    expect(raw.failure.type).toBe('RATE_LIMIT');
    expect(raw.resume_at).not.toBeNull();
  });

  it('keeps the goal out of the process argument list', async () => {
    const secretish = 'rotate the Apollo signing key';
    const proc = execFile(
      process.execPath,
      [CLI, 'run', 'fake', secretish, '--scenario', 'delayed'],
      { cwd: repo.dir, env: { ...process.env, RESURGE_HOME: home.dir(), FAKE_DELAY_MS: '3000' } },
    );
    await new Promise((r) => setTimeout(r, 1200));

    const { stdout: ps } = await exec('ps', ['-Ao', 'args'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    // Match the agent process itself, not any shell that merely mentions it.
    const agentLines = ps
      .split('\n')
      .filter((l) => /^\S*node\b.*[/]scripts[/]fake-agent\.js/.test(l.trim()));
    proc.kill('SIGKILL');

    expect(agentLines.length).toBeGreaterThan(0);
    // The supervisor's own argv carries the goal, but the agent's does not:
    // prompts travel over stdin so they never reach the process table.
    for (const line of agentLines) expect(line).not.toContain(secretish);
  });
});
