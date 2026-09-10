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
    await expectEmptyPromptExit(buildStartArgs());
  });

  it('accepts the exact resume argv Resurge builds', async () => {
    await expectEmptyPromptExit(buildResumeArgs('00000000-0000-4000-8000-000000000000'));
  });

  it('passes the capability probe', async () => {
    const probe = await probeCapabilities(BIN);
    expect(probe.ok).toBe(true);
    home.cleanup();
  });
});

async function expectEmptyPromptExit(args: string[]): Promise<void> {
  try {
    await execWithClosedStdin(args);
    throw new Error('Codex unexpectedly accepted an empty prompt');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    expect(`${e.stdout ?? ''}\n${e.stderr ?? ''}`).toContain('No prompt provided via stdin.');
  }
}

function execWithClosedStdin(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve();
    });
    child.stdin?.end();
  });
}

describe.skipIf(installed)('installed Codex CLI compatibility (skipped)', () => {
  it('is opt-in and requires an installed codex', () => {
    // Present so the suite reports honestly rather than looking like coverage
    // it does not have.
    expect(installed).toBe(false);
  });
});
