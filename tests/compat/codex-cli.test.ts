import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildResumeArgs, buildStartArgs } from '../../src/agents/codex-adapter.js';
import { probeCapabilities } from '../../src/agents/capability-probe.js';
import { useTempHome } from '../helpers/home.js';

const exec = promisify(execFile);
const BIN = process.env['RESURGE_CODEX_BIN'] ?? 'codex';

async function codexInstalled(): Promise<boolean> {
  if (process.env['RESURGE_TEST_REAL_CODEX'] !== '1') return false;
  try {
    await exec(BIN, ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const installed = await codexInstalled();

/**
 * The only layer that can catch upstream CLI drift.
 *
 * The argv unit tests prove Resurge is self-consistent; they cannot notice if
 * the Codex CLI changes its flags out from under us. These do, by running the
 * real binary — so they are opt-in (RESURGE_TEST_REAL_CODEX=1, `npm run
 * test:codex`) and skip automatically when Codex is not installed.
 */
describe.skipIf(!installed)('installed Codex CLI compatibility', () => {
  const home = useTempHome();

  it('accepts the exact start argv Resurge builds', async () => {
    await expect(
      exec(BIN, [...buildStartArgs().slice(0, -1), '--help'], { timeout: 20_000 }),
    ).resolves.toBeDefined();
  });

  it('accepts the exact resume argv Resurge builds', async () => {
    const args = buildResumeArgs('00000000-0000-4000-8000-000000000000').slice(0, -2);
    await expect(exec(BIN, [...args, '--help'], { timeout: 20_000 })).resolves.toBeDefined();
  });

  it('passes the capability probe', async () => {
    const probe = await probeCapabilities(BIN);
    expect(probe.ok).toBe(true);
    home.cleanup();
  });
});

describe.skipIf(installed)('installed Codex CLI compatibility (skipped)', () => {
  it('is opt-in and requires an installed codex', () => {
    // Present so the suite reports honestly rather than looking like coverage
    // it does not have.
    expect(installed).toBe(false);
  });
});
