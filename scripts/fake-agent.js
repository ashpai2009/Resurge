#!/usr/bin/env node
/**
 * A stand-in for the Codex CLI.
 *
 * Exists so the whole supervisor — failure classification, waiting, repo
 * verification, restart limits, orphan handling — can be exercised end to end
 * without an installed Codex and without spending a token of real quota.
 *
 * Usage:  fake-agent.js exec --json [resume <id>] - --scenario <name>
 * The prompt is read from stdin, exactly as the real adapter delivers it.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const argv = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const scenario = flag('scenario', process.env.FAKE_SCENARIO ?? 'success');
const json = argv.includes('--json');
const resumeIdx = argv.indexOf('resume');
const resumingSession = resumeIdx !== -1 ? argv[resumeIdx + 1] : null;
const delayMs = Number(flag('delay-ms', '250'));
const counterFile = flag('counter-file', process.env.FAKE_COUNTER_FILE);

// --version / --help exist so the capability probe can be pointed at this
// script and behave exactly as it would against a real CLI.
if (argv.includes('--version')) {
  process.stdout.write('fake-agent 0.1.0\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  process.stdout.write('Usage: fake-agent exec [--json] [resume <id>] [-]\n');
  process.exit(0);
}

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const say = (text) => process.stdout.write(text + '\n');
const err = (text) => process.stderr.write(text + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function emitThreadStarted() {
  const threadId = resumingSession ?? randomUUID();
  if (json) out({ type: 'thread.started', thread_id: threadId });
  else say(`thread started: ${threadId}`);
  return threadId;
}

function bumpCounter() {
  if (!counterFile) return 1;
  mkdirSync(path.dirname(counterFile), { recursive: true });
  let n = 0;
  try {
    n = Number(readFileSync(counterFile, 'utf8').trim()) || 0;
  } catch { /* first run */ }
  n += 1;
  writeFileSync(counterFile, String(n));
  return n;
}

const prompt = await readStdin();
if (process.env.FAKE_PROMPT_LOG) {
  appendFileSync(process.env.FAKE_PROMPT_LOG, `${JSON.stringify({ scenario, resumingSession, prompt })}\n`);
}

switch (scenario) {
  case 'success': {
    emitThreadStarted();
    if (json) out({ type: 'item.completed', text: 'edited src/reviewer/workflow.ts' });
    else say('edited src/reviewer/workflow.ts');
    say('done');
    process.exit(0);
    break;
  }

  case 'rate-limit': {
    emitThreadStarted();
    err('Error: usage limit reached. Try again at 1:30 AM');
    process.exit(1);
    break;
  }

  case 'rate-limit-no-time': {
    emitThreadStarted();
    err('Error: usage limit reached. Please try again later.');
    process.exit(1);
    break;
  }

  case 'network': {
    emitThreadStarted();
    err('request failed: getaddrinfo ENOTFOUND api.openai.com');
    process.exit(1);
    break;
  }

  case 'crash': {
    emitThreadStarted();
    err('panic: unexpected nil dereference');
    err('    at run (/app/agent.js:42:9)');
    process.exit(3);
    break;
  }

  case 'segfault': {
    // Dies by signal, so it reports {code: null, signal}. The case a
    // naive "exit code 0 means success" check would silently accept.
    emitThreadStarted();
    process.kill(process.pid, 'SIGSEGV');
    await sleep(1000);
    break;
  }

  case 'crash-then-success': {
    emitThreadStarted();
    const n = bumpCounter();
    const failures = Number(flag('fail-times', '2'));
    if (n <= failures) {
      err(`panic: transient failure ${n}`);
      process.exit(3);
    }
    say(`succeeded on attempt ${n}`);
    process.exit(0);
    break;
  }

  case 'delayed': {
    emitThreadStarted();
    say('working...');
    await sleep(delayMs);
    say('done');
    process.exit(0);
    break;
  }

  case 'noisy-stdout': {
    // Prints alarming-looking text as ORDINARY OUTPUT and finishes cleanly.
    // Nothing here may be classified as a failure.
    emitThreadStarted();
    say('reviewing logs: the server returned 429 in three places');
    say('also saw ECONNRESET and "usage limit reached" in the archived log');
    say('done');
    process.exit(0);
    break;
  }

  case 'bare-uuid': {
    // Prints an unlabelled UUID that must NOT be adopted as a session id.
    say(`processing batch ${randomUUID()}`);
    say('done');
    process.exit(0);
    break;
  }

  case 'session-invalid': {
    if (resumingSession) {
      err(`Error: session not found: ${resumingSession}`);
      process.exit(1);
    }
    emitThreadStarted();
    say('done');
    process.exit(0);
    break;
  }

  case 'split-jsonl': {
    // Emits JSON split mid-line across separate writes, to prove the framer
    // reassembles rather than regexing raw chunks.
    const id = randomUUID();
    const line = JSON.stringify({ type: 'thread.started', thread_id: id });
    const cut = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, cut));
    await sleep(30);
    process.stdout.write(line.slice(cut) + '\n');
    out({ type: 'item.completed', text: 'ok' });
    process.exit(0);
    break;
  }

  case 'orphan': {
    // Spawns a detached grandchild that outlives this process, so orphan
    // reconciliation has something real to find.
    emitThreadStarted();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    say(`grandchild ${child.pid}`);
    await sleep(delayMs);
    say('done');
    process.exit(0);
    break;
  }

  default: {
    err(`unknown scenario: ${scenario}`);
    process.exit(64);
  }
}
