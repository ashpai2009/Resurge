import type { LeaseHandle } from '../persistence/lease.js';
import { claimRequests, settleRequest } from '../persistence/control.js';
import type { ControlKind } from '../types/control.js';
import type { Clock } from '../util/clock.js';
import { logger } from '../util/logger.js';

/**
 * The supervisor's periodic tick: refresh the lease heartbeat, and apply any
 * control requests other processes have filed.
 *
 * Control requests exist because only the lease owner may write task state, so
 * `resurge pause` from another shell drops a file here instead of touching the
 * record. A request is settled only after the resulting transition has landed,
 * which makes consumption at-least-once: a crash mid-apply replays it rather
 * than losing the pause the user asked for.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly lease: LeaseHandle,
    private readonly taskId: string,
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly onRequest: (kind: ControlKind) => Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      await this.lease.heartbeat();
      await this.consume();
    } catch (err) {
      // A lost lease surfaces here first. Log it; the next state write will
      // throw LeaseLostError and stop the supervisor properly.
      logger.warn('heartbeat failed', err);
    }
  }

  private async consume(): Promise<void> {
    for (const claimed of claimRequests(this.taskId, this.clock.now().getTime())) {
      await this.onRequest(claimed.request.kind);
      settleRequest(claimed);
    }
  }
}
