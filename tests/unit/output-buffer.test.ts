import { describe, expect, it } from 'vitest';
import { OutputBuffer } from '../../src/supervisor/output-buffer.js';

describe('OutputBuffer', () => {
  it('bounds UTF-8 bytes rather than JavaScript code units', () => {
    const buffer = new OutputBuffer(8);
    buffer.append('prefix-');
    buffer.append('🙂🙂🙂');

    expect(buffer.text).not.toContain('prefix');
    expect(Buffer.byteLength(buffer.text.replace(/^\uFFFD/, ''), 'utf8')).toBeLessThanOrEqual(8);
    expect(buffer.text).toContain('🙂');
  });
});
