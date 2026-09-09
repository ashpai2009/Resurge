/**
 * Bounded tail of recent output.
 *
 * The supervisor must remember what the agent said last without accumulating
 * an unbounded buffer over a multi-hour run, so this keeps only the final
 * `limit` bytes.
 */
export class OutputBuffer {
  private buf = Buffer.alloc(0);
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  append(chunk: string): void {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    if (this.buf.byteLength > this.limit) {
      this.buf = this.buf.subarray(this.buf.byteLength - this.limit);
    }
  }

  get text(): string {
    return this.buf.toString('utf8');
  }

  get isEmpty(): boolean {
    return this.buf.byteLength === 0;
  }
}
