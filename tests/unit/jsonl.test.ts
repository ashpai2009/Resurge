import { describe, expect, it } from 'vitest';
import { JsonlFramer } from '../../src/util/jsonl.js';

describe('JSONL framing', () => {
  it('reassembles a line split across chunks', () => {
    const framer = new JsonlFramer();
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'abc' });
    const cut = Math.floor(line.length / 2);

    expect(framer.push(line.slice(0, cut))).toHaveLength(0);
    const out = framer.push(line.slice(cut) + '\n');

    expect(out).toHaveLength(1);
    expect(out[0]!.json).toEqual({ type: 'thread.started', thread_id: 'abc' });
  });

  it('emits multiple complete lines arriving in one chunk', () => {
    const framer = new JsonlFramer();
    const out = framer.push('{"a":1}\n{"b":2}\n');
    expect(out.map((l) => l.json)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('tolerates non-JSON lines interleaved with events', () => {
    const framer = new JsonlFramer();
    const out = framer.push('warning: something\n{"a":1}\n');
    expect(out).toHaveLength(2);
    expect(out[0]!.json).toBeNull();
    expect(out[0]!.raw).toBe('warning: something');
    expect(out[1]!.json).toEqual({ a: 1 });
  });

  it('handles CRLF line endings', () => {
    const framer = new JsonlFramer();
    expect(framer.push('{"a":1}\r\n')[0]!.json).toEqual({ a: 1 });
  });

  it('flushes a trailing unterminated line at end of stream', () => {
    const framer = new JsonlFramer();
    framer.push('{"a":1}');
    expect(framer.flush()[0]!.json).toEqual({ a: 1 });
  });

  it('caps an over-long line instead of growing the buffer forever', () => {
    const framer = new JsonlFramer(64);
    framer.push('x'.repeat(500));
    // The over-long line is dropped, and the framer recovers on the next one.
    const out = framer.push('\n{"a":1}\n');
    expect(framer.dropped).toBe(1);
    expect(out.map((l) => l.json)).toEqual([{ a: 1 }]);
  });
});
