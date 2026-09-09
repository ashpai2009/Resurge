/**
 * Control requests: how a non-owner asks the lease holder to do something.
 *
 * A process that does not hold the lease must never write task state. So
 * `resurge pause` on a live task drops a request file and the lease owner
 * performs the transition itself. See persistence/control.ts.
 */
export type ControlKind = 'pause';

export interface ControlRequest {
  kind: ControlKind;
  requested_at: string;
  requested_by_pid: number;
}
