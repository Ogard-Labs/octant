import { APPLE_INPUT_GRANT_MS } from "@octant/domain";

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

  /** True while the grant is live; a live grant is renewed by being used. */
  use(threadId: string, simulatorId: string): boolean {
    const scope = key(threadId, simulatorId);
    const expiresAt = this.#expiry.get(scope);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.#now()) {
      this.#expiry.delete(scope);
      return false;
    }
    this.#expiry.set(scope, this.#now() + APPLE_INPUT_GRANT_MS);
    return true;
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
