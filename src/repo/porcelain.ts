import type { PorcelainEntry } from '../types/repo.js';

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * Full entries are kept rather than bare filenames because the status
 * characters carry the safety-relevant information: a path that moved from
 * ' M' to 'MM' changed underneath us, and a 'UU' path is an unresolved
 * conflict that must never be resumed into automatically.
 *
 * In -z output a rename/copy entry is two NUL-terminated fields: the status
 * plus the new path, then the original path as the following record.
 */
export function parsePorcelain(raw: string): PorcelainEntry[] {
  const records = raw.split('\0').filter((r) => r.length > 0);
  const entries: PorcelainEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.length < 4) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const filePath = rec.slice(3);

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const orig = records[i + 1];
      i += 1;
      entries.push(orig === undefined ? { x, y, path: filePath } : { x, y, path: filePath, origPath: orig });
      continue;
    }
    entries.push({ x, y, path: filePath });
  }

  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True for any unmerged/conflicted state. */
export function isConflicted(e: PorcelainEntry): boolean {
  if (e.x === 'U' || e.y === 'U') return true;
  const pair = `${e.x}${e.y}`;
  return pair === 'AA' || pair === 'DD';
}

export function entryKey(e: PorcelainEntry): string {
  return e.origPath ? `${e.origPath} -> ${e.path}` : e.path;
}

export function formatEntry(e: PorcelainEntry): string {
  return `${e.x}${e.y} ${entryKey(e)}`;
}
