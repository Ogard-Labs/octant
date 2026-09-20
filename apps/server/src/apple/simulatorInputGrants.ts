import { APPLE_INPUT_GRANT_MS, isAppleSimulatorInputKind } from "@octant/domain";

/**
 * The longest an action may run: its own timeout allows ten minutes. An
 * expired grant is kept that long, so an input it admitted just before it ran
 * out can still renew it when it finishes.
 */
const LONGEST_ACTION_MS = 10 * 60_000;

export interface SimulatorInputGrant {
  readonly simulatorId: string;
  readonly expiresAt: string;
}

/**
 * Which Simulators a thread may send input to without a new approval.
 *
 * One approved tap, key or typed text opens its Simulator to further input on
 * that thread, and each delivered input keeps it open; shutting the Simulator
 * down closes it for every thread. Grants live in memory only: a restarted host
 * asks again, which is the safe direction to forget in.
 */
export class SimulatorInputGrants {
  readonly #now: () => number;
  readonly #expiry = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(threadId: string, simulatorId: string): void {
    this.#expiry.set(key(threadId, simulatorId), this.#now() + APPLE_INPUT_GRANT_MS);
  }

  /**
   * True while the grant is live. Looking does not extend it: every request
   * looks, including ones that fail, and only a delivered input renews.
   */
  isOpen(threadId: string, simulatorId: string): boolean {
    const scope = key(threadId, simulatorId);
    const expiresAt = this.#expiry.get(scope);
    if (expiresAt === undefined) return false;
    if (expiresAt + LONGEST_ACTION_MS <= this.#now()) this.#expiry.delete(scope);
    return expiresAt > this.#now();
  }

  /**
   * Keeps a grant open another fifteen minutes. An input the grant itself
   * admitted can finish just after it ran out, and still counts. Any other
   * input, full access or the first one approved, renews only a grant that is
   * live: it never needed the grant, so it must not bring one back. A grant
   * that was closed by a shutdown or by the thread is gone and stays gone.
   */
  renew(threadId: string, simulatorId: string, admittedByGrant = false): void {
    const expiresAt = this.#expiry.get(key(threadId, simulatorId));
    if (expiresAt === undefined) return;
    if (admittedByGrant || expiresAt > this.#now()) this.open(threadId, simulatorId);
  }

  /**
   * What a finished action means for the grants. Only what happened counts,
   * not what was asked: a delivered input keeps its Simulator open, and a
   * Simulator that was shut down is closed to every thread. A failed input or
   * a failed shutdown changes nothing, since the device session carries on.
   */
  afterAction(
    threadId: string,
    action: { readonly kind: string; readonly simulatorId?: string },
    outcome: string,
    admittedByGrant = false,
  ): void {
    if (outcome !== "succeeded" || action.simulatorId === undefined) return;
    if (action.kind === "shutdown") this.revokeSimulator(action.simulatorId);
    else if (isAppleSimulatorInputKind(action.kind as never)) {
      this.renew(threadId, action.simulatorId, admittedByGrant);
    }
  }

  revokeSimulator(simulatorId: string): void {
    for (const scope of this.#expiry.keys())
      if (scope.endsWith(`:${simulatorId}`)) this.#expiry.delete(scope);
  }

  revokeThread(threadId: string): void {
    for (const scope of this.#expiry.keys())
      if (scope.startsWith(`${threadId}:`)) this.#expiry.delete(scope);
  }

  list(threadId: string): ReadonlyArray<SimulatorInputGrant> {
    const now = this.#now();
    const grants: SimulatorInputGrant[] = [];
    for (const [scope, expiresAt] of this.#expiry) {
      if (!scope.startsWith(`${threadId}:`) || expiresAt <= now) continue;
      grants.push({
        simulatorId: scope.slice(threadId.length + 1),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    }
    return grants;
  }
}

function key(threadId: string, simulatorId: string): string {
  return `${threadId}:${simulatorId}`;
}
