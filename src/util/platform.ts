/**
 * POSIX-specific primitives, isolated so a future Windows port replaces one
 * module instead of a grep across the tree.
 *
 * v0.1 supports macOS and Linux only. The safety model leans on process-start
 * identity, process-group signalling and O_NOFOLLOW, none of which port
 * cleanly, so Windows is refused at startup rather than silently degraded.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';

export function isSupportedPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

export function assertSupportedPlatform(): void {
  if (!isSupportedPlatform()) {
    throw new Error(
      `Resurge v0.1 supports macOS and Linux only (detected: ${process.platform}). ` +
        `Its safety guarantees depend on POSIX process identity and signalling.`,
    );
  }
}

/**
 * A value that changes when the machine reboots, so leases written before a
 * reboot are provably stale rather than merely old.
 */
export function bootId(): string {
  try {
    if (process.platform === 'linux') {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    }
    const out = execFileSync('sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return out.trim();
  } catch {
    // Unknown boot id is not fatal, but it must never look equal to another
    // unknown one, or two different boots would compare as the same machine.
    return `unknown-${os.hostname()}`;
  }
}

/**
 * Process start time for `pid`, used to defeat PID reuse: a recycled PID has a
 * different start time, so a stale lease naming it is provably stale.
 * Returns null when the process does not exist.
 */
export function processIdentity(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export type Liveness =
  | { kind: 'DEAD' }
  | { kind: 'ALIVE'; identity: string }
  | { kind: 'UNKNOWN'; detail: string };

/**
 * Answers "is this process still running, and is it still the same process".
 * UNKNOWN is a real answer, not an error: the caller must escalate to a human
 * rather than guess, because guessing wrong runs two agents on one repo.
 */
export function probeProcess(pid: number): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: 'UNKNOWN', detail: `invalid pid ${pid}` };
  }
  const identity = processIdentity(pid);
  if (identity !== null) return { kind: 'ALIVE', identity };

  // `ps` found nothing. Confirm with kill(0) before declaring death, since a
  // ps failure and a dead process are different things.
  try {
    process.kill(pid, 0);
    // Exists but ps gave us nothing: we cannot establish identity.
    return { kind: 'UNKNOWN', detail: `pid ${pid} exists but identity unavailable` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { kind: 'DEAD' };
    if (code === 'EPERM') {
      return { kind: 'UNKNOWN', detail: `pid ${pid} owned by another user` };
    }
    return { kind: 'UNKNOWN', detail: `pid ${pid}: ${String(code ?? err)}` };
  }
}

/** Signals an entire process group, so an agent's own children die with it. */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  process.kill(-Math.abs(pgid), signal);
}

export function hostname(): string {
  return os.hostname();
}
