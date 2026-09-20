import { APPLE_INPUT_GRANT_MS, isAppleSimulatorInputKind } from "@octant/domain";

/**
 * The longest an action may run: its own timeout allows ten minutes. An input
 * that finishes later than that after a grant ran out was not authorized under
 * it, so it does not renew it.
 */
const LONGEST_ACTION_MS = 10 * 60_000;
/** How many finished actions are remembered, so a replayed one is recognized. */
const REMEMBERED_ACTIONS = 256;

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
  readonly #settled = new Set<string>();

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
   * Keeps a grant open another fifteen minutes. An input authorized under the
   * grant can finish just after it ran out, and still counts; a grant that was
   * closed, or ran out long ago, stays closed.
   */
  renew(threadId: string, simulatorId: string): void {
    const expiresAt = this.#expiry.get(key(threadId, simulatorId));
    if (expiresAt !== undefined && expiresAt + LONGEST_ACTION_MS > this.#now()) {
      this.open(threadId, simulatorId);
    }
  }

  /**
   * What a finished action means for the grants. Only what happened counts,
   * not what was asked: a delivered input keeps its Simulator open, and a
   * Simulator that was shut down is closed to every thread. A failed input or
   * a failed shutdown changes nothing, since the device session carries on.
   * A request answered again from what was stored delivers nothing new, so
   * the same action renews only once.
   */
  afterAction(
    threadId: string,
    action: { readonly kind: string; readonly simulatorId?: string; readonly actionId: string },
    outcome: string,
  ): void {
    if (outcome !== "succeeded" || action.simulatorId === undefined) return;
    if (this.#settled.has(action.actionId)) return;
    this.#settled.add(action.actionId);
    if (this.#settled.size > REMEMBERED_ACTIONS) {
      const oldest = this.#settled.values().next().value;
      if (oldest !== undefined) this.#settled.delete(oldest);
    }
    if (action.kind === "shutdown") this.revokeSimulator(action.simulatorId);
    else if (isAppleSimulatorInputKind(action.kind as never)) {
      this.renew(threadId, action.simulatorId);
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
