import { describe, expect, it } from 'vitest';
import { FailureDetector } from '../../src/failure/detector.js';
import { FakeClock } from '../../src/util/clock.js';
import type { DetectionInput } from '../../src/types/failure.js';

const clock = () => new FakeClock('2026-09-08T22:00:00Z');
const det = () => new FailureDetector(clock());

function input(over: Partial<DetectionInput> = {}): DetectionInput {
  return {
    exit: { code: 1, signal: null },
    stdoutTail: '',
    stderrTail: '',
    jsonlEvents: [],
    ...over,
  };
}

describe('the detection trigger covers signal deaths', () => {
  it('classifies a SIGSEGV child as a crash, not a clean finish', () => {
    // A signal-killed child reports {code: null, signal}. Treating "exit 0" as
    // the success condition would let every signal death pass as success.
    const event = det().detect(input({ exit: { code: null, signal: 'SIGSEGV' } }));
    expect(event?.type).toBe('AGENT_CRASH');
    expect(event?.evidence).toMatch(/SIGSEGV/);
  });

  it('returns null only for a truly clean exit', () => {
    expect(det().detect(input({ exit: { code: 0, signal: null } }))).toBeNull();
    expect(det().detect(input({ exit: { code: 0, signal: 'SIGTERM' } }))).not.toBeNull();
  });
});

describe('rate-limit detection', () => {
  const phrases = [
    'Error: usage limit reached',
    'You have hit your usage limit for today',
    'request was rate limited',
    'rate-limited by upstream',
    'quota exceeded for this organization',
    'HTTP 429 Too Many Requests',
    'insufficient_quota',
  ];

  for (const phrase of phrases) {
    it(`recognises "${phrase}" on stderr`, () => {
      const event = det().detect(input({ stderrTail: phrase }));
      expect(event?.type).toBe('RATE_LIMIT');
      expect(event?.retryable).toBe(true);
    });
  }

  it('persists a parsed reset time', () => {
    const event = det().detect(
      input({ stderrTail: 'usage limit reached. try again at 1:30 AM' }),
    );
    expect(event?.type).toBe('RATE_LIMIT');
    expect(event?.retryAfter).toBeDefined();
    expect(new Date(event!.retryAfter!).getHours()).toBe(1);
  });

  it('omits retryAfter when no reset time is present', () => {
    const event = det().detect(input({ stderrTail: 'usage limit reached, try later' }));
    expect(event?.type).toBe('RATE_LIMIT');
    expect(event?.retryAfter).toBeUndefined();
  });

  it('wins over the crash rule despite the non-zero exit', () => {
    const event = det().detect(
      input({ exit: { code: 1, signal: null }, stderrTail: 'usage limit reached' }),
    );
    expect(event?.type).toBe('RATE_LIMIT');
  });
});

describe('network detection', () => {
  const phrases = [
    'getaddrinfo ENOTFOUND api.openai.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'EAI_AGAIN',
    'socket hang up',
    'network is unreachable',
    'TLS handshake failed',
  ];
  for (const phrase of phrases) {
    it(`recognises "${phrase}"`, () => {
      expect(det().detect(input({ stderrTail: phrase }))?.type).toBe('NETWORK_DOWN');
    });
  }
});

describe('crash classification', () => {
  it('recognises a panic', () => {
    expect(det().detect(input({ stderrTail: 'panic: runtime error' }))?.type).toBe('AGENT_CRASH');
  });
  it('recognises a stack trace', () => {
    const trace = 'Error: boom\n    at run (/app/x.js:10:5)\n';
    expect(det().detect(input({ stderrTail: trace }))?.type).toBe('AGENT_CRASH');
  });
  it('falls back to the exit code with no other evidence', () => {
    const event = det().detect(input({ exit: { code: 3, signal: null } }));
    expect(event?.type).toBe('AGENT_CRASH');
    expect(event?.evidence).toMatch(/code 3/);
  });
});

describe('session-invalid detection', () => {
  it('recognises an explicit missing session and beats every other rule', () => {
    const event = det().detect(input({ stderrTail: 'Error: session not found' }));
    expect(event?.type).toBe('SESSION_INVALID');
  });
  it('does NOT fire on a generic resume failure', () => {
    const event = det().detect(input({ stderrTail: 'resume failed: something went wrong' }));
    expect(event?.type).not.toBe('SESSION_INVALID');
  });
});

describe('evidence ranking keeps stdout from driving recovery', () => {
  it('ignores a rate-limit phrase printed as ordinary stdout content', () => {
    // The agent was reading a log file that happened to mention rate limits.
    // stdout tops out at 0.6, below the 0.7 acceptance threshold, so this can
    // never trigger an automatic wait-and-retry.
    const event = det().detect(
      input({ exit: { code: 1, signal: null }, stdoutTail: 'usage limit reached' }),
    );
    expect(event?.type).toBe('UNKNOWN_FAILURE');
    expect(event?.retryable).toBe(false);
    expect(event?.evidence).toMatch(/low-confidence RATE_LIMIT/);
  });

  it('accepts the same phrase from stderr', () => {
    expect(det().detect(input({ stderrTail: 'usage limit reached' }))?.type).toBe('RATE_LIMIT');
  });

  it('accepts the same phrase from a structured JSONL event', () => {
    const event = det().detect(
      input({ jsonlEvents: [{ type: 'error', message: 'usage limit reached' }] }),
    );
    expect(event?.type).toBe('RATE_LIMIT');
    expect(event?.source).toBe('jsonl');
    expect(event?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('does not trust an agent message merely because the transport is JSONL', () => {
    const event = det().detect(
      input({
        jsonlEvents: [
          { type: 'item.completed', item: { type: 'agent_message', text: 'usage limit reached' } },
        ],
      }),
    );
    expect(event?.type).toBe('AGENT_CRASH');
  });

  it('treats a structured turn failure as a failure even when the process exits zero', () => {
    const event = det().detect(
      input({
        exit: { code: 0, signal: null },
        jsonlEvents: [{ type: 'turn.failed', error: { message: 'usage limit reached' } }],
      }),
    );
    expect(event?.type).toBe('RATE_LIMIT');
  });

  it('lets strong crash evidence beat a weak stdout rate-limit mention', () => {
    const event = det().detect(
      input({ stdoutTail: 'error: usage limit reached', stderrTail: 'panic: runtime error' }),
    );
    expect(event?.type).toBe('AGENT_CRASH');
  });

  it('ignores a bare 429 on stdout with no error context at all', () => {
    const event = det().detect(
      input({ exit: { code: 1, signal: null }, stdoutTail: 'the answer is 429\nmoving on\n' }),
    );
    // No rate-limit classification survives; it degrades to a plain crash.
    expect(event?.type).toBe('AGENT_CRASH');
  });
});

describe('the crash / unknown split', () => {
  it('treats a bare non-zero exit as a crash, which gets bounded retries', () => {
    // Per the spec: an unexplained exit that is not a rate limit or a network
    // failure is a crash, and crashes are retried at most three times.
    const event = det().detect(
      input({ exit: { code: 1, signal: null }, stdoutTail: 'something weird happened' }),
    );
    expect(event?.type).toBe('AGENT_CRASH');
    expect(event?.retryable).toBe(true);
  });

  it('marks a recognised-but-unconvincing signal UNKNOWN_FAILURE and not retryable', () => {
    // Here we *almost* concluded something. Acting on a hunch is worse than
    // stopping, so this escalates instead of retrying.
    const event = det().detect(
      input({ exit: { code: 1, signal: null }, stdoutTail: 'error: usage limit reached' }),
    );
    expect(event?.type).toBe('UNKNOWN_FAILURE');
    expect(event?.retryable).toBe(false);
    expect(event?.evidence).toMatch(/low-confidence RATE_LIMIT/);
  });
});
