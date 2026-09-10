import type { AgentAdapter, AgentProcess } from '../types/agent.js';
import type { Task } from '../types/task.js';
import { ChildProcessLauncher, type ProcessLauncher } from './launcher.js';
import { probeCapabilities } from './capability-probe.js';

/**
 * Codex CLI adapter.
 *
 * Argv follows the documented shape, with --json as an `exec` option and
 * `resume` as its subcommand:
 *
 *   codex exec --json --approve-for-me -
 *   codex exec --json --approve-for-me resume <id> -
 *
 * The trailing `-` reads the prompt from stdin. That is a safety property, not
 * a style choice: a prompt in argv is visible to every local user via `ps`.
 */
export const CODEX_BIN = process.env['RESURGE_CODEX_BIN'] ?? 'codex';

// --approve-for-me already selects the workspace-write sandbox. Passing an
// explicit --sandbox alongside it is rejected by current Codex CLI releases.
const EXECUTION_POLICY = ['--approve-for-me'] as const;

export function buildStartArgs(): string[] {
  return ['exec', '--json', ...EXECUTION_POLICY, '-'];
}

export function buildResumeArgs(sessionId: string): string[] {
  return ['exec', '--json', ...EXECUTION_POLICY, 'resume', sessionId, '-'];
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  private readonly launcher: ProcessLauncher;

  constructor(launcher: ProcessLauncher = new ChildProcessLauncher()) {
    this.launcher = launcher;
  }

  async start(task: Task, prompt: string): Promise<AgentProcess> {
    return this.launcher.launch({
      command: CODEX_BIN,
      args: buildStartArgs(),
      cwd: this.cwdFor(task),
      stdin: prompt,
    });
  }

  async startFresh(task: Task, continuationPrompt: string): Promise<AgentProcess> {
    return this.start(task, continuationPrompt);
  }

  async resume(sessionId: string, task: Task, prompt: string): Promise<AgentProcess> {
    return this.launcher.launch({
      command: CODEX_BIN,
      args: buildResumeArgs(sessionId),
      cwd: this.cwdFor(task),
      stdin: prompt,
    });
  }

  /**
   * Accepts a session id ONLY from the documented `thread.started` event.
   *
   * An earlier design also scraped labelled UUIDs out of plain text. That is
   * too permissive: resuming the wrong session is worse than starting a fresh
   * one, and a fresh session with a full continuation prompt is a good fallback.
   */
  detectSessionId(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const obj = event as Record<string, unknown>;
    if (obj['type'] !== 'thread.started') return null;

    const direct = obj['thread_id'];
    if (isUuid(direct)) return direct;

    // Some emitters nest the payload; accept that shape, still only for
    // thread.started, and still only a real UUID.
    const nested = obj['thread'];
    if (nested && typeof nested === 'object') {
      const id = (nested as Record<string, unknown>)['id'];
      if (isUuid(id)) return id;
    }
    return null;
  }

  supportsSessionResume(): boolean {
    return process.env['RESURGE_CODEX_RESUME'] !== '0';
  }

  /**
   * Proves the binary exists and that the argv we construct actually parses.
   * Explicitly NOT a health check: it says nothing about authentication, quota
   * or whether the API is reachable.
   */
  async installationCheck(): Promise<{ ok: boolean; detail: string }> {
    const probe = await probeCapabilities(CODEX_BIN);
    return probe.ok
      ? { ok: true, detail: `codex ${probe.version}` }
      : { ok: false, detail: probe.detail };
  }

  private cwdFor(task: Task): string {
    return task.workdir ?? task.repo_at_start?.root ?? process.cwd();
  }
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
