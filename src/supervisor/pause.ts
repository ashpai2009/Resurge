import type { AgentProcess } from '../types/agent.js';
import { logger } from '../util/logger.js';

export type StopOutcome =
  | { kind: 'STOPPED'; exit: { code: number | null; signal: string | null } }
  | { kind: 'UNKILLABLE'; pid: number | undefined };

/**
 * Stops a running agent and waits for confirmation that it is actually gone.
 *
 * The ordering is the point. Writing PAUSED before the child is confirmed dead
 * persists a lie: the task looks paused while an agent is still editing files.
 * So the caller writes PAUSE_REQUESTED, calls this, and only writes PAUSED once
 * this resolves with STOPPED.
 */
export async function stopAgent(proc: AgentProcess, graceMs: number): Promise<StopOutcome> {
  // Signals the whole process group, so the agent's own subprocesses die with
  // it rather than being orphaned.
  proc.kill('SIGTERM');

  const graceful = await raceExit(proc, graceMs);
  if (graceful) return { kind: 'STOPPED', exit: graceful };

  logger.warn(`agent did not exit within ${graceMs}ms; sending SIGKILL`);
  proc.kill('SIGKILL');

  const forced = await raceExit(proc, graceMs);
  if (forced) return { kind: 'STOPPED', exit: forced };

  return { kind: 'UNKILLABLE', pid: proc.pid };
}

function raceExit(
  proc: AgentProcess,
  ms: number,
): Promise<{ code: number | null; signal: string | null } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    void proc.wait().then((exit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exit);
    });
  });
}
