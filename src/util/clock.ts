/**
 * Injectable time. Reset-time parsing and backoff are the parts of Resurge
 * most likely to be wrong, and untestable if they read the wall clock
 * directly, so everything time-dependent takes a Clock.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test clock: starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = typeof start === 'string' ? new Date(start) : start;
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date | string): void {
    this.current = typeof d === 'string' ? new Date(d) : d;
  }
}
