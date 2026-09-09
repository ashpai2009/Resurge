import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from '../types/task.js';

const exec = promisify(execFile);

/**
 * What a clean process exit actually means.
 *
 * A zero exit proves the process ended well. It does not prove the goal is
 * done: an agent that hits a blocker, asks a clarifying question, or completes
 * half the work also exits zero. So a clean exit lands in
 * AGENT_EXITED_SUCCESSFULLY, and only one of these policies can promote it to
 * COMPLETED.
 */
export type CompletionOutcome =
  | { kind: 'AWAIT_CONFIRMATION'; message: string }
  | { kind: 'COMPLETED'; message: string }
  | { kind: 'REQUIRES_REVIEW'; message: string; output: string };

export async function evaluateCompletion(task: Task): Promise<CompletionOutcome> {
  if (!task.verify_argv || task.verify_argv.length === 0) {
    return {
      kind: 'AWAIT_CONFIRMATION',
      message:
        'The agent exited cleanly. That does not mean the goal is done — review the work, ' +
        `then run \`resurge complete ${task.task_id}\` to mark it complete.`,
    };
  }

  const [command, ...args] = task.verify_argv;
  const cwd = task.repo_at_interruption?.root ?? task.repo_at_start?.root ?? process.cwd();

  try {
    // execFile with an argv vector: no shell, so nothing in the command is
    // re-interpreted, quoted or globbed.
    await exec(command!, args, {
      cwd,
      encoding: 'utf8',
      timeout: 30 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      kind: 'COMPLETED',
      message: `Verification passed: ${task.verify_argv.join(' ')}`,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    return {
      kind: 'REQUIRES_REVIEW',
      message: `Verification failed: ${task.verify_argv.join(' ')}`,
      output: output.slice(-4000),
    };
  }
}
