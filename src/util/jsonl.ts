/**
 * Buffered JSONL line framer.
 *
 * Stream chunks do not align with lines: a single JSON event routinely arrives
 * split across two `data` events, and two events routinely arrive in one. Any
 * code that regexes raw chunks will therefore miss events and match across
 * boundaries. Every JSONL consumer reads through this instead.
 */
export interface FramedLine {
  raw: string;
  /** Parsed object, or null when the line was not JSON (agents interleave logs). */
  json: unknown | null;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export class JsonlFramer {
  private residual = '';
  private dropping = false;
  private readonly maxLineBytes: number;
  private droppedLines = 0;

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Feeds a chunk, returning only the lines that are now complete. */
  push(chunk: string): FramedLine[] {
    const out: FramedLine[] = [];
    let buf = this.residual + chunk;
    let idx: number;

    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (this.dropping) {
        // We were mid-way through an over-long line; this newline ends it.
        this.dropping = false;
        continue;
      }
      if (line.length === 0) continue;
      out.push(frame(line));
    }

    // Guard against a producer that never emits a newline: bound the residual
    // rather than growing it until the process dies.
    if (Buffer.byteLength(buf, 'utf8') > this.maxLineBytes) {
      this.dropping = true;
      this.droppedLines += 1;
      buf = '';
    }
    this.residual = buf;
    return out;
  }

  /** Flushes a trailing unterminated line at end-of-stream. */
  flush(): FramedLine[] {
    const rest = this.residual;
    this.residual = '';
    if (this.dropping) {
      this.dropping = false;
      return [];
    }
    if (rest.trim().length === 0) return [];
    return [frame(rest)];
  }

  get dropped(): number {
    return this.droppedLines;
  }
}

function frame(raw: string): FramedLine {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { raw, json: null };
  }
  try {
    return { raw, json: JSON.parse(trimmed) };
  } catch {
    return { raw, json: null };
  }
}
