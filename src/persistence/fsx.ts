/**
 * Filesystem primitives with the durability and safety properties the rest of
 * the persistence layer assumes.
 *
 * Atomic rename prevents a *torn* file. It does not prevent a lost update and
 * it does not make the write durable on its own, so the sequence here is
 * temp -> fsync(file) -> rename -> fsync(dir).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export class SymlinkRefusedError extends Error {
  constructor(target: string) {
    super(`refusing to write through a symlink: ${target}`);
    this.name = 'SymlinkRefusedError';
  }
}

/**
 * Refuses to write when the destination has been replaced by a symlink — the
 * classic trick for redirecting a privileged write somewhere else.
 */
function assertNotSymlink(target: string): void {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw new SymlinkRefusedError(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function fsyncDir(dir: string): void {
  // Renaming is only durable once the *directory* entry is flushed. Some
  // filesystems reject O_RDONLY fsync on a directory; that is not fatal.
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Durable, atomic, owner-only write. */
export function writeFileAtomic(target: string, data: string): void {
  assertNotSymlink(target);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let fd: number | undefined;
  let writeComplete = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
    fs.writeFileSync(fd, data, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    writeComplete = true;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (!writeComplete) unlinkQuiet(tmp);
  }

  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  fsyncDir(dir);
}

/**
 * Creates a file only if it does not exist (O_EXCL). Returns false on EEXIST.
 * This is how the guard and control requests are claimed; it cannot *replace*
 * an existing file, which is precisely why lease takeover needs the guard.
 */
export function createExclusive(target: string, data: string): boolean {
  assertNotSymlink(target);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
  let fd: number | undefined;
  let created = false;
  let complete = false;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow(),
      FILE_MODE,
    );
    created = true;
    fs.writeFileSync(fd, data, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    complete = true;
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (created && !complete) unlinkQuiet(target);
  }
}

function noFollow(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

export function readFileOrNull(target: string): string | null {
  try {
    assertNotSymlink(target);
    return fs.readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SymlinkRefusedError) throw err;
    throw err;
  }
}

/** Reads a bounded tail without following symlinks or loading the whole file. */
export function readFileTail(
  target: string,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  assertNotSymlink(target);
  const noFollowFlag = noFollow();
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag);
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: size > length };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors after the read result is known.
      }
    }
  }
}

export function statMtimeMs(target: string): number | null {
  try {
    return fs.lstatSync(target).mtimeMs;
  } catch {
    return null;
  }
}

export function unlinkQuiet(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    /* ignore */
  }
}

export function renameIfExists(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
