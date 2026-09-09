import type { AgentAdapter } from '../types/agent.js';
import { CodexAdapter } from './codex-adapter.js';
import { FakeAdapter } from './fake-adapter.js';

export interface AdapterOptions {
  /** Only meaningful for the fake agent. */
  scenario?: string;
}

/**
 * Maps an agent name to its adapter.
 *
 * v0.1 ships Codex plus the test harness. A ClaudeAdapter or GeminiAdapter
 * would be one more case here and one more file in agents/ — the supervisor,
 * detector and recovery layers know nothing about which agent they are driving.
 */
export function createAdapter(name: string, options: AdapterOptions = {}): AgentAdapter {
  switch (name) {
    case 'codex':
      return new CodexAdapter();
    case 'fake':
      return new FakeAdapter(options.scenario ?? 'success');
    default:
      throw new Error(`unknown agent "${name}". Supported: codex (and "fake" for testing).`);
  }
}

export const SUPPORTED_AGENTS = ['codex', 'fake'] as const;
