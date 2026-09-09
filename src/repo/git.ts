import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Thin wrappers over the four git commands Resurge needs. Uses execFile with an
 * argv array — never a shell string — so repository paths containing spaces or
 * shell metacharacters cannot turn into command injection.
 */
export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, stdout: '', error: (e.stderr || e.message || 'git failed').trim() };
  }
}

export function repoRoot(cwd: string): Promise<GitResult> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export function currentBranch(cwd: string): Promise<GitResult> {
  return git(cwd, ['branch', '--show-current']);
}

export function headSha(cwd: string): Promise<GitResult> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

/**
 * NUL-delimited porcelain v1. The -z form is what makes paths with newlines or
 * quotes safe to parse; the human-readable form quotes and escapes them.
 */
export function statusPorcelain(cwd: string): Promise<GitResult> {
  return git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}
