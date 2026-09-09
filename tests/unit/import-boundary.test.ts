import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
}

describe('detection is structurally separated from recovery', () => {
  it('nothing under failure/ can import recovery, supervisor or agents', () => {
    // The rule is "regex detectors must not restart processes". Stating it in a
    // comment is not enforcement; this makes it impossible to violate quietly.
    const offenders: string[] = [];

    for (const file of tsFiles(path.join(srcDir, 'failure'))) {
      for (const spec of importsOf(file)) {
        if (/(^|\/)(recovery|supervisor|agents)\//.test(spec)) {
          offenders.push(`${path.relative(srcDir, file)} imports ${spec}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('nothing under repo/ depends on recovery or supervisor either', () => {
    // The verifier must stay a pure function of two snapshots.
    const offenders: string[] = [];
    for (const file of tsFiles(path.join(srcDir, 'repo'))) {
      for (const spec of importsOf(file)) {
        if (/(^|\/)(recovery|supervisor)\//.test(spec)) {
          offenders.push(`${path.relative(srcDir, file)} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only the supervisor coordinates across modules', () => {
    // A quick guard against the supervisor's job leaking into the CLI.
    const cliFiles = tsFiles(path.join(srcDir, 'cli'));
    const offenders = cliFiles.filter((f) =>
      importsOf(f).some((s) => s.includes('failure/rules/')),
    );
    expect(offenders).toEqual([]);
  });
});
