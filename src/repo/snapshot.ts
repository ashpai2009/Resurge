import type { RepoSnapshot } from '../types/repo.js';
import { currentBranch, headSha, repoRoot, statusPorcelain } from './git.js';
import { parsePorcelain } from './porcelain.js';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { PorcelainEntry } from '../types/repo.js';

/**
 * Captures the repository state at a point in time.
 *
 * A failure to capture is recorded as `unavailable_reason` rather than silently
 * producing an empty snapshot: "we did not look" and "we looked and found
 * nothing" lead to opposite decisions in the verifier, so they must not be
 * representable the same way.
 */
export async function captureSnapshot(cwd: string, clock: Clock = systemClock): Promise<RepoSnapshot> {
  const capturedAt = clock.now().toISOString();

  const root = await repoRoot(cwd);
  if (!root.ok) {
    if (isNotGitRepository(root.error)) {
      return {
        root: null,
        branch: null,
        head_sha: null,
        entries: [],
        captured_at: capturedAt,
      };
    }
    return {
      root: null,
      branch: null,
      head_sha: null,
      entries: [],
      captured_at: capturedAt,
      unavailable_reason: `git repository check failed (${firstLine(root.error)})`,
    };
  }

  const rootPath = root.stdout.trim();
  const [branch, head, status] = await Promise.all([
    currentBranch(rootPath),
    headSha(rootPath),
    statusPorcelain(rootPath),
  ]);

  if (!status.ok) {
    return {
      root: rootPath,
      branch: branch.ok ? nullIfEmpty(branch.stdout.trim()) : null,
      head_sha: head.ok ? nullIfEmpty(head.stdout.trim()) : null,
      entries: [],
      captured_at: capturedAt,
      unavailable_reason: `git status failed: ${firstLine(status.error)}`,
    };
  }

  const entries = await addContentHashes(rootPath, parsePorcelain(status.stdout));

  return {
    root: rootPath,
    // An empty branch name is a detached HEAD, which is a real state, not a
    // missing value; null records "git could not tell us".
    branch: branch.ok ? nullIfEmpty(branch.stdout.trim()) : null,
    head_sha: head.ok ? nullIfEmpty(head.stdout.trim()) : null,
    entries,
    captured_at: capturedAt,
  };
}

async function addContentHashes(root: string, entries: PorcelainEntry[]): Promise<PorcelainEntry[]> {
  const out: PorcelainEntry[] = [];
  for (const entry of entries) {
    out.push({ ...entry, content_hash: await digestPath(root, entry.path) });
  }
  return out;
}

async function digestPath(root: string, relative: string): Promise<string> {
  const absolute = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootPrefix)) {
    return 'unsafe-path';
  }

  try {
    const stat = await fs.promises.lstat(absolute);
    if (stat.isSymbolicLink()) {
      return `symlink:${createHash('sha256').update(await fs.promises.readlink(absolute)).digest('hex')}`;
    }
    if (!stat.isFile()) return stat.isDirectory() ? 'directory' : `mode:${stat.mode}`;

    return await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(absolute);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'missing' : `unreadable:${code ?? 'unknown'}`;
  }
}

function isNotGitRepository(error: string | undefined): boolean {
  return /not a git repository/i.test(error ?? '');
}

function nullIfEmpty(s: string): string | null {
  return s.length === 0 ? null : s;
}

function firstLine(s: string | undefined): string {
  return (s ?? 'unknown error').split('\n')[0]!.trim();
}

export function isGitRepo(snap: RepoSnapshot): boolean {
  return snap.root !== null;
}
