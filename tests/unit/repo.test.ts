import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TempRepo } from '../helpers/git.js';
import { captureSnapshot } from '../../src/repo/snapshot.js';
import { verifyRepo } from '../../src/repo/verifier.js';
import { parsePorcelain } from '../../src/repo/porcelain.js';
import type { RepoSnapshot } from '../../src/types/repo.js';

let repo: TempRepo;
beforeEach(() => {
  repo = new TempRepo();
});
afterEach(() => repo.cleanup());

describe('porcelain parsing', () => {
  it('keeps status characters, not just filenames', () => {
    const entries = parsePorcelain(' M src/a.ts\0?? src/b.ts\0');
    expect(entries).toEqual([
      { x: ' ', y: 'M', path: 'src/a.ts' },
      { x: '?', y: '?', path: 'src/b.ts' },
    ]);
  });

  it('round-trips a rename with its original path', () => {
    const entries = parsePorcelain('R  new.ts\0old.ts\0 M other.ts\0');
    expect(entries).toContainEqual({ x: 'R', y: ' ', path: 'new.ts', origPath: 'old.ts' });
    expect(entries).toContainEqual({ x: ' ', y: 'M', path: 'other.ts' });
  });

  it('handles paths containing spaces', () => {
    expect(parsePorcelain(' M src/a file.ts\0')).toEqual([{ x: ' ', y: 'M', path: 'src/a file.ts' }]);
  });
});

describe('the comparison baseline is the interruption, not the task start', () => {
  it('SAFE_RESUME when nothing changed', async () => {
    const baseline = await captureSnapshot(repo.dir);
    const current = await captureSnapshot(repo.dir);
    expect(verifyRepo(baseline, current).kind).toBe('SAFE_RESUME');
  });

  it('allows commits the agent made *during* the run', async () => {
    // The agent committed while Resurge was watching, so that commit is part of
    // the interruption snapshot and must not block the resume.
    const atStart = await captureSnapshot(repo.dir);
    repo.commit('work the agent did while supervised');
    const atInterruption = await captureSnapshot(repo.dir);
    const now = await captureSnapshot(repo.dir);

    expect(verifyRepo(atInterruption, now).kind).toBe('SAFE_RESUME');
    // Against the task-start snapshot it would wrongly look like tampering:
    expect(verifyRepo(atStart, now).kind).toBe('REQUIRES_REVIEW');
  });

  it('blocks commits made *after* the interruption', async () => {
    const atInterruption = await captureSnapshot(repo.dir);
    const expected = repo.head();
    repo.commit('someone else committed while the agent was down');
    const now = await captureSnapshot(repo.dir);

    const verdict = verifyRepo(atInterruption, now);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toContain(expected.slice(0, 12));
    expect(verdict.reasons.join('\n')).toMatch(/Expected HEAD/);
    expect(verdict.reasons.join('\n')).toMatch(/Automatic resume has been blocked/);
  });

  it('requires review when no interruption snapshot was captured', async () => {
    const now = await captureSnapshot(repo.dir);
    const verdict = verifyRepo(null, now);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons[0]).toMatch(/no trustworthy baseline/i);
  });
});

describe('branch and HEAD divergence', () => {
  it('REQUIRES_REVIEW when the branch changed', async () => {
    const baseline = await captureSnapshot(repo.dir);
    repo.git(['checkout', '-q', '-b', 'backend-review']);
    const current = await captureSnapshot(repo.dir);

    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/Expected branch: main/);
    expect(verdict.reasons.join('\n')).toMatch(/Current branch:  backend-review/);
  });

  it('REQUIRES_REVIEW when HEAD moved on the same branch', async () => {
    const baseline = await captureSnapshot(repo.dir);
    repo.commit('another');
    const current = await captureSnapshot(repo.dir);
    expect(verifyRepo(baseline, current).kind).toBe('REQUIRES_REVIEW');
  });
});

describe('dirty-state comparison', () => {
  it('REQUIRES_REVIEW when a new dirty entry appeared after interruption', async () => {
    repo.write('a.ts', 'one');
    const baseline = await captureSnapshot(repo.dir);
    repo.write('b.ts', 'two');
    const current = await captureSnapshot(repo.dir);
    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/new dirty entry/i);
  });

  it('REQUIRES_REVIEW when a dirty file disappeared', async () => {
    repo.write('a.ts', 'one');
    const baseline = await captureSnapshot(repo.dir);
    repo.git(['add', 'a.ts']);
    repo.git(['commit', '-q', '-m', 'someone committed the agent work']);
    const current = await captureSnapshot(repo.dir);

    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/no longer modified|Expected HEAD/);
  });

  it('REQUIRES_REVIEW when a file status flipped from " M" to "MM"', () => {
    const baseline = snap([{ x: ' ', y: 'M', path: 'src/a.ts' }]);
    const current = snap([{ x: 'M', y: 'M', path: 'src/a.ts' }]);
    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/status of src\/a\.ts changed/);
  });

  it('REQUIRES_REVIEW when a dirty file changed contents but kept the same status', async () => {
    repo.write('a.ts', 'first version');
    const baseline = await captureSnapshot(repo.dir);
    repo.write('a.ts', 'different contents');
    const current = await captureSnapshot(repo.dir);

    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/contents of a\.ts changed/i);
  });

  it('REQUIRES_REVIEW on an unresolved conflict', () => {
    const baseline = snap([]);
    const current = snap([{ x: 'U', y: 'U', path: 'src/a.ts' }]);
    const verdict = verifyRepo(baseline, current);
    expect(verdict.kind).toBe('REQUIRES_REVIEW');
    expect(verdict.reasons.join('\n')).toMatch(/conflict/i);
  });

  it('SAFE_RESUME outside a git repository', () => {
    const notARepo: RepoSnapshot = {
      root: null,
      branch: null,
      head_sha: null,
      entries: [],
      captured_at: new Date().toISOString(),
    };
    expect(verifyRepo(notARepo, notARepo).kind).toBe('SAFE_RESUME');
  });

  it('captures an ordinary non-git directory as available, not as a Git failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resurge-nongit-'));
    try {
      const snapshot = await captureSnapshot(dir);
      expect(snapshot.root).toBeNull();
      expect(snapshot.unavailable_reason).toBeUndefined();
      expect(verifyRepo(snapshot, await captureSnapshot(dir)).kind).toBe('SAFE_RESUME');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function snap(entries: { x: string; y: string; path: string }[]): RepoSnapshot {
  return {
    root: '/repo',
    branch: 'main',
    head_sha: 'abc123abc123',
    entries,
    captured_at: new Date().toISOString(),
  };
}
