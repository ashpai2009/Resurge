import type { Clock } from './clock.js';

/**
 * Abortable sleep. Rate-limit waits run for hours, so they must be
 * interruptible by Ctrl-C and by a pause request without waiting them out.
 */
export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realSleeper: Sleeper = {
  sleep(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/**
 * Test sleeper: never actually waits, but advances a FakeClock so code that
 * sleeps then checks the time observes a consistent world.
 */
export function instantSleeper(clock: { advance(ms: number): void }): Sleeper {
  return {
    async sleep(ms: number, signal?: AbortSignal) {
      if (signal?.aborted) throw new AbortError();
      clock.advance(ms);
    },
  };
}

export function withJitter(ms: number, fraction = 0.1): number {
  const delta = ms * fraction;
  return Math.max(0, Math.round(ms - delta + Math.random() * 2 * delta));
}
