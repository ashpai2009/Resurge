import { describe, expect, it } from 'vitest';
import { parseArgs, validateFlags } from '../../src/cli/args.js';

describe('CLI flag validation', () => {
  it('rejects unknown flags instead of silently weakening the requested policy', () => {
    const args = parseArgs(['run', 'codex', 'goal', '--no-store-ouptut']);
    expect(validateFlags(args)).toMatch(/unknown flag.*no-store-ouptut/i);
  });

  it('rejects a value flag with no value', () => {
    const args = parseArgs(['run', 'codex', 'goal', '--cwd']);
    expect(validateFlags(args)).toBe('--cwd requires a value');
  });

  it('accepts the documented run flags and preserves verify argv', () => {
    const args = parseArgs([
      'run',
      'codex',
      'goal',
      '--cwd',
      '/repo',
      '--no-store-output',
      '--',
      'npm',
      'test',
    ]);
    expect(validateFlags(args)).toBeNull();
    expect(args.rest).toEqual(['npm', 'test']);
  });
});
