/** One entry from `git status --porcelain=v1 -z`. */
export interface PorcelainEntry {
  /** Index status character. */
  x: string;
  /** Worktree status character. */
  y: string;
  path: string;
  /** Present for renames/copies: the path the file came from. */
  origPath?: string;
  /** SHA-256 of the worktree file (or a typed marker for non-files). */
  content_hash?: string;
}

export interface RepoSnapshot {
  root: string | null;
  branch: string | null;
  head_sha: string | null;
  entries: PorcelainEntry[];
  captured_at: string;
  /**
   * Set when the snapshot could not be taken (not a git repo, git failed).
   * Recorded explicitly rather than left null, because "we did not look" and
   * "we looked and found nothing" must not be confused by the verifier.
   */
  unavailable_reason?: string;
}

export type RepoVerdictKind = 'SAFE_RESUME' | 'REQUIRES_REVIEW';

export interface RepoVerdict {
  kind: RepoVerdictKind;
  /** Empty for SAFE_RESUME; one entry per detected divergence otherwise. */
  reasons: string[];
}
