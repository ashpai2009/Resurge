import { spawn } from 'node:child_process';
import type { AgentProcess } from '../types/agent.js';
import { killProcessGroup } from '../util/platform.js';
import { logger } from '../util/logger.js';

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Written to the child's stdin and then closed. Keeps prompts out of argv. */
  stdin?: string;
  env?: Record<string, string>;
}

/**
 * Spawns an agent as a child process.
 *
 * Two properties matter here and are the reason this is its own module:
 *
 *  - `detached: true` gives the child its own process group, so signalling it
 *    reaches the agent's own subprocesses instead of orphaning them.
 *  - the prompt goes over stdin, never argv, so goals and continuation prompts
 *    do not appear in `ps` output for every local user to read.
 *
 * Swapping in node-pty for v0.2 means reimplementing this interface and nothing
 * else; the supervisor only knows about AgentProcess.
 */
export interface ProcessLauncher {
  launch(spec: LaunchSpec): AgentProcess;
}

export class ChildProcessLauncher implements ProcessLauncher {
  launch(spec: LaunchSpec): AgentProcess {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(spec.env ?? {}) },
    });

    if (spec.stdin !== undefined) {
      child.stdin.on('error', (err) => logger.debug('agent stdin closed early', err));
      child.stdin.end(spec.stdin);
    } else {
      child.stdin.end();
    }

    const startedAt = new Date().toISOString();
    // With detached:true the child leads its own group, so pgid === pid.
    const pgid = child.pid;

    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal: signal ?? null }));
      child.on('error', (err) => {
        logger.warn('failed to launch agent', err);
        resolve({ code: null, signal: null });
      });
    });

    return {
      pid: child.pid,
      pgid,
      startedAt,
      onStdout: (cb) => child.stdout.on('data', (d: Buffer) => cb(d.toString())),
      onStderr: (cb) => child.stderr.on('data', (d: Buffer) => cb(d.toString())),
      wait: () => exited,
      kill: (signal: NodeJS.Signals = 'SIGTERM') => {
        if (pgid === undefined) return;
        try {
          killProcessGroup(pgid, signal);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ESRCH') logger.warn(`failed to signal process group ${pgid}`, err);
        }
      },
    };
  }
}
