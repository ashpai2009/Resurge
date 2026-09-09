/**
 * Child that tries to take over a lease at a coordinated moment, used to race
 * two stealers against one proven-stale lease.
 */
import { acquireLease } from '../../dist/persistence/lease.js';

const taskId = process.argv[2];
const startAt = Number(process.argv[3]);

// Spin to a common wall-clock instant so both children contend for real.
while (Date.now() < startAt) { /* tight wait, sub-millisecond alignment */ }

try {
  const lease = await acquireLease(taskId);
  process.stdout.write(JSON.stringify({ ok: true, generation: lease.leaseGeneration, token: lease.fencingToken }) + '\n');
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message), kind: err && err.reviewKind }) + '\n');
}
