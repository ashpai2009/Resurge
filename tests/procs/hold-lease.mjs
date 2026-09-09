/**
 * Child process that acquires a task lease and holds it.
 *
 * Protocol over stdout (one JSON line per event):
 *   {"event":"acquired","token":...,"generation":...}
 *   {"event":"write-ok"} / {"event":"write-failed","error":...}
 *   {"event":"release-ok"} / {"event":"release-failed","error":...}
 *
 * Commands over stdin, one word per line: write | heartbeat | release | exit
 */
import { acquireLease, __setAfterTokenVerify } from '../../dist/persistence/lease.js';
import { JsonTaskStore } from '../../dist/persistence/json-store.js';

const taskId = process.argv[2];
const suspendAtSeam = process.argv.includes('--suspend-at-seam');

function say(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let lease;
try {
  lease = await acquireLease(taskId);
} catch (err) {
  say({ event: 'acquire-failed', error: String(err && err.message), kind: err && err.reviewKind });
  process.exit(2);
}
say({ event: 'acquired', token: lease.fencingToken, generation: lease.leaseGeneration });

if (suspendAtSeam) {
  // Suspend inside the guard, right after the fencing token was verified —
  // the precise window a displaced owner would try to exploit.
  __setAfterTokenVerify(async () => {
    say({ event: 'at-seam' });
    process.kill(process.pid, 'SIGSTOP');
  });
}

const store = new JsonTaskStore();

let buf = '';
process.stdin.on('data', async (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const cmd = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (cmd === 'write') {
      try {
        const loaded = store.load(taskId);
        const task = loaded && loaded.ok ? loaded.task : null;
        if (!task) throw new Error('no task on disk');
        await store.save(lease, { ...task, goal: 'WRITTEN BY OLD OWNER' });
        say({ event: 'write-ok' });
      } catch (err) {
        say({ event: 'write-failed', error: String(err && err.name) });
      }
    } else if (cmd === 'heartbeat') {
      try {
        await lease.heartbeat();
        say({ event: 'heartbeat-ok' });
      } catch (err) {
        say({ event: 'heartbeat-failed', error: String(err && err.name) });
      }
    } else if (cmd === 'release') {
      try {
        await lease.release();
        say({ event: 'release-ok' });
      } catch (err) {
        say({ event: 'release-failed', error: String(err && err.name) });
      }
    } else if (cmd === 'exit') {
      process.exit(0);
    }
  }
});
