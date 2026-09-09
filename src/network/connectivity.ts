import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';
import type { Clock } from '../util/clock.js';
import { systemClock } from '../util/clock.js';
import type { Sleeper } from '../util/sleep.js';
import { realSleeper } from '../util/sleep.js';
import { logger } from '../util/logger.js';

/**
 * Connectivity probing.
 *
 * This is deliberately advisory. Reachability of a DNS name says nothing about
 * whether the agent's API is up, whether the user's credentials are valid, or
 * whether their quota is exhausted — so a probe result never sets a terminal
 * task state, and a probe that keeps failing never blocks forever. When the
 * budget runs out Resurge attempts the resume anyway: a real failed invocation
 * is better evidence than a guess about the network.
 */
export interface NetworkChecker {
  isOnline(): Promise<boolean>;
  /**
   * Waits for connectivity, up to a bounded budget.
   * Returns whether connectivity was observed — not whether to proceed.
   */
  waitForConnectivity(budgetMs: number, signal?: AbortSignal): Promise<boolean>;
}

const PROBE_HOSTS = ['api.openai.com', 'cloudflare.com'];

export class DnsNetworkChecker implements NetworkChecker {
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;

  constructor(clock: Clock = systemClock, sleeper: Sleeper = realSleeper) {
    this.clock = clock;
    this.sleeper = sleeper;
  }

  async isOnline(): Promise<boolean> {
    for (const host of PROBE_HOSTS) {
      if (await resolves(host)) return true;
    }
    return tcpReachable('1.1.1.1', 443, 3000);
  }

  async waitForConnectivity(budgetMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.clock.now().getTime() + budgetMs;
    let backoff = 5_000;

    for (;;) {
      if (signal?.aborted) return false;
      if (await this.isOnline()) return true;

      const remaining = deadline - this.clock.now().getTime();
      if (remaining <= 0) {
        logger.warn(
          'network probe budget exhausted; attempting the resume anyway, ' +
            'since a real agent invocation is better evidence than a probe',
        );
        return false;
      }
      await this.sleeper.sleep(Math.min(backoff, remaining), signal);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    }
  }
}

async function resolves(host: string): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  try {
    const addrs = await resolver.resolve4(host);
    return addrs.length > 0;
  } catch {
    return false;
  }
}

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Always-online checker for tests that are not about the network. */
export const alwaysOnline: NetworkChecker = {
  isOnline: async () => true,
  waitForConnectivity: async () => true,
};
