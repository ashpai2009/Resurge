import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, ensureLayout } from '../persistence/paths.js';
import { buildResumeArgs, buildStartArgs } from './codex-adapter.js';
import { logger } from '../util/logger.js';

const exec = promisify(execFile);

export interface ProbeResult {
  ok: boolean;
  version: string;
  detail: string;
}

/**
 * Verifies that the CLI is installed and that the exact argv Resurge builds is
 * accepted by it.
 *
 * Appending --help is not sufficient: clap may short-circuit before checking
 * conflicts between options. Instead, the probe runs each exact argv with an
 * empty stdin. A compatible Codex parses the complete command and stops with
 * "No prompt provided" before it can contact the service or consume quota.
 *
 * Result is cached per version, because this runs before every resume and a
 * long-lived task may resume many times.
 */
export async function probeCapabilities(bin: string): Promise<ProbeResult> {
  let version: string;
  try {
    const { stdout } = await exec(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    version = stdout.trim().split('\n')[0] ?? 'unknown';
  } catch (err) {
    return {
      ok: false,
      version: 'unknown',
      detail:
        `\`${bin} --version\` failed: ${errText(err)}. ` +
        `Install the Codex CLI, or point RESURGE_CODEX_BIN at it.`,
    };
  }

  const cached = readCache(bin, version);
  if (cached) return cached;

  const forms: { label: string; args: string[] }[] = [
    { label: 'start', args: buildStartArgs() },
    { label: 'resume', args: buildResumeArgs('00000000-0000-4000-8000-000000000000') },
  ];

  for (const form of forms) {
    try {
      await execWithClosedStdin(bin, form.args, 15_000);
    } catch (err) {
      if (isEmptyPromptExit(err)) continue;
      const result: ProbeResult = {
        ok: false,
        version,
        detail:
          `This Codex build did not accept the ${form.label} form Resurge constructs ` +
          `(\`${bin} ${form.args.join(' ')}\`): ${errText(err)}`,
      };
      writeCache(bin, version, result);
      return result;
    }
  }

  const result: ProbeResult = { ok: true, version, detail: `codex ${version}` };
  writeCache(bin, version, result);
  return result;
}

function isEmptyPromptExit(err: unknown): boolean {
  const e = err as { stdout?: string; stderr?: string };
  return `${e.stdout ?? ''}\n${e.stderr ?? ''}`.includes('No prompt provided via stdin.');
}

function execWithClosedStdin(
  bin: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

function cacheFile(bin: string, version: string): string {
  const contract = createHash('sha256')
    .update(JSON.stringify([buildStartArgs(), buildResumeArgs('<session-id>')]))
    .digest('hex')
    .slice(0, 12);
  const key = `${path.basename(bin)}-${version}-${contract}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(cacheDir(), `capabilities-${key}.json`);
}

function readCache(bin: string, version: string): ProbeResult | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(bin, version), 'utf8')) as ProbeResult;
  } catch {
    return null;
  }
}

function writeCache(bin: string, version: string, result: ProbeResult): void {
  try {
    ensureLayout();
    fs.writeFileSync(cacheFile(bin, version), JSON.stringify(result, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.debug('could not cache capability probe', err);
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).split('\n')[0]!.trim();
}
