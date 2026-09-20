import { APPLE_INPUT_GRANT_MS, appleActionOpensInputGrant } from "@octant/domain";
import { isReplayedEvidence } from "./appleToolchainService";

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

/** Who holds a grant, and for which Simulator. */
export interface SimulatorInputScope {
  readonly windowId: string;
  readonly threadId: string;
  readonly simulatorId: string;
}

/**
 * Which Simulators a window may send input to, on one thread, without a new
 * approval.
 *
 * One approved Allow input opens its destination to further input from that
 * window on that thread, and each delivered input keeps it open; shutting the
 * destination down closes it for everyone. A grant belongs to the window whose
 * native confirmation opened it, like every other approval on this host, so a
 * second client on the same thread — a browser tab, say — needs its own. It ends
 * with the window. Grants live in memory only: a restarted host asks again,
 * which is the safe direction to forget in.
 */
export class SimulatorInputGrants {
  readonly #now: () => number;
  readonly #wallNow: () => number;
  readonly #grants = new Map<string, SimulatorInputScope & { readonly expiresAt: number }>();

  /**
   * `now` measures grant lifetime: the host passes its suspend-aware authority
   * clock, so a machine that sleeps or has its clock set back cannot stretch a
   * grant. `wallNow` is only for telling the pane when a grant ends.
   */
  constructor(now: () => number = Date.now, wallNow: () => number = Date.now) {
    this.#now = now;
    this.#wallNow = wallNow;
  }

  open(scope: SimulatorInputScope): void {
    this.#grants.set(key(scope), { ...scope, expiresAt: this.#now() + APPLE_INPUT_GRANT_MS });
  }

  /**
   * True while the grant is live. Looking does not extend it: every request
   * looks, including ones that fail, and only a delivered input renews.
   */
  isOpen(scope: SimulatorInputScope): boolean {
    const grant = this.#grants.get(key(scope));
    if (grant === undefined) return false;
    if (grant.expiresAt + LONGEST_ACTION_MS <= this.#now()) this.#grants.delete(key(scope));
    return grant.expiresAt > this.#now();
  }

  /**
   * Keeps a grant open another fifteen minutes. An input the grant itself
   * admitted can finish just after it ran out, and still counts, but only within
   * the longest an action may run: one that settles later than that ran on a
   * clock nobody can vouch for, and brings nothing back. Any other
   * input, full access or the first one approved, renews only a grant that is
   * live: it never needed the grant, so it must not bring one back. A grant
   * that was closed by a shutdown or by the window is gone and stays gone.
   */
  renew(scope: SimulatorInputScope, admittedByGrant = false): void {
    const grant = this.#grants.get(key(scope));
    if (grant === undefined) return;
    const now = this.#now();
    const withinGrace = admittedByGrant && now < grant.expiresAt + LONGEST_ACTION_MS;
    if (withinGrace || grant.expiresAt > now) this.open(scope);
  }

  /**
   * Settles a finished action from the request, its evidence and the context it
   * ran under. Every path that runs Apple actions calls this, so the workbench
   * route and an agent's tool close and renew grants the same way. Evidence the
   * service gave again from memory delivered nothing, so it renews and closes
   * nothing.
   */
  settle(
    windowId: string,
    request: { readonly kind: string; readonly simulatorId?: unknown },
    evidence: { readonly outcome: string },
    context: { readonly threadId: unknown; readonly inputGranted?: boolean },
  ): void {
    if (isReplayedEvidence(evidence)) return;
    this.afterAction(
      { windowId, threadId: String(context.threadId) },
      {
        kind: request.kind,
        ...(request.simulatorId === undefined ? {} : { simulatorId: String(request.simulatorId) }),
      },
      evidence.outcome,
      context.inputGranted === true,
    );
  }

  /**
   * What a finished action means for the grants. Only what happened counts,
   * not what was asked: a delivered input keeps its Simulator open, and a
   * Simulator that was shut down is closed to everyone. A failed input or a
   * failed shutdown changes nothing, since the device session carries on.
   */
  afterAction(
    who: Pick<SimulatorInputScope, "windowId" | "threadId">,
    action: { readonly kind: string; readonly simulatorId?: string },
    outcome: string,
    admittedByGrant = false,
  ): void {
    if (outcome !== "succeeded" || action.simulatorId === undefined) return;
    if (action.kind === "shutdown") this.revokeSimulator(action.simulatorId);
    else if (action.kind === "open-input") {
      // Allow input is the confirmation that opens the destination, even if a
      // previous grant already ran out. Taps only renew a grant that is live.
      this.open({ ...who, simulatorId: action.simulatorId });
    } else if (appleActionOpensInputGrant(action.kind as never)) {
      this.renew({ ...who, simulatorId: action.simulatorId }, admittedByGrant);
    }
  }

  /**
   * Closes the grants of every Simulator that discovery found not booted. A
   * Simulator can be shut down from Xcode or `simctl`, which no Octant action
   * sees; booting it again starts a device session nobody confirmed, so the old
   * grant must not carry over. Only a discovery sees this, so a shutdown and
   * reboot between two discoveries goes unnoticed and the grant's own fifteen
   * minutes are what bound it.
   */
  closeUnlessBooted(
    simulators: ReadonlyArray<{ readonly simulatorId: unknown; readonly state: string }>,
  ): void {
    for (const simulator of simulators)
      if (simulator.state !== "booted") this.revokeSimulator(String(simulator.simulatorId));
  }

  revokeSimulator(simulatorId: string): void {
    for (const [scope, grant] of this.#grants)
      if (grant.simulatorId === simulatorId) this.#grants.delete(scope);
  }

  revokeWindow(windowId: string): void {
    for (const [scope, grant] of this.#grants)
      if (grant.windowId === windowId) this.#grants.delete(scope);
  }

  /**
   * A window's live grants on a thread. The expiry is what remains of the grant
   * laid on the wall clock, because the pane compares it to its own clock and
   * the host's authority clock can trail that by however long the machine
   * slept.
   */
  list(windowId: string, threadId: string): ReadonlyArray<SimulatorInputGrant> {
    const now = this.#now();
    const wallNow = this.#wallNow();
    const grants: SimulatorInputGrant[] = [];
    for (const grant of this.#grants.values()) {
      if (grant.windowId !== windowId || grant.threadId !== threadId || grant.expiresAt <= now)
        continue;
      grants.push({
        simulatorId: grant.simulatorId,
        expiresAt: new Date(wallNow + (grant.expiresAt - now)).toISOString(),
      });
    }
    return grants;
  }
}

function key(scope: SimulatorInputScope): string {
  return `${scope.windowId}:${scope.threadId}:${scope.simulatorId}`;
}
