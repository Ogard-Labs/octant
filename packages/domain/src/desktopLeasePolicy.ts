import type {
  DesktopLeaseEndReason,
  DesktopLeaseOwner,
  DesktopLeaseState,
  DesktopProviderLocality,
  EventActor,
  ProviderExecutionPolicy,
} from "@octant/contracts";

/**
 * Pure rules for thread-leased disposable desktops. The host lease service
 * applies them; docs/design/disposable-desktops.md owns them.
 */

/** A thread holds at most two leases; a host runs at most two host-local ones. */
export const DESKTOP_LEASE_CAPS = { perThread: 2, hostLocalPerHost: 2 } as const;

const TRANSITIONS: Readonly<Record<DesktopLeaseState, ReadonlySet<DesktopLeaseState>>> = {
  requested: new Set(["provisioning", "refused", "failed", "releasing"]),
  provisioning: new Set(["ready", "refused", "failed", "releasing"]),
  ready: new Set(["releasing"]),
  releasing: new Set(["released", "release-failed"]),
  // A retry that verifies absence records only the outcome, so a desktop the
  // provider keeps refusing to destroy does not grow the journal per attempt.
  "release-failed": new Set(["released"]),
  released: new Set(),
  refused: new Set(),
  failed: new Set(),
};

export function desktopLeaseTransitionAllowed(
  from: DesktopLeaseState,
  to: DesktopLeaseState,
): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * Whether a lease may still hold a running desktop. `refused` and `failed`
 * never produced one the host kept; `released` was verified gone.
 */
export function desktopLeaseHoldsDesktop(state: DesktopLeaseState): boolean {
  return state !== "released" && state !== "refused" && state !== "failed";
}

export type DesktopLeaseAcquireGate =
  | { readonly kind: "proceed" }
  | { readonly kind: "refused"; readonly reason: "plan-mode" }
  /** `in-thread` asks under ordinary posture rules; `billed` needs a person every time. */
  | { readonly kind: "ask"; readonly asks: "in-thread" | "billed" };

/**
 * Plan refuses. A billed provider spends the person's money, which no posture
 * covers, so a person confirms every billed lease even under Full access. A
 * person acquiring a host-local desktop has already decided; an agent asks
 * unless the thread runs with Full access.
 */
export function decideDesktopLeaseAcquire(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly billed: boolean;
  readonly initiator: EventActor["kind"];
}): DesktopLeaseAcquireGate {
  if (input.executionPolicy === "plan") return { kind: "refused", reason: "plan-mode" };
  if (input.billed) return { kind: "ask", asks: "billed" };
  if (input.initiator === "local-user" || input.initiator === "remote-device") {
    return { kind: "proceed" };
  }
  if (input.executionPolicy === "full-access") return { kind: "proceed" };
  return { kind: "ask", asks: "in-thread" };
}

export interface DesktopLeaseHolding {
  readonly owner: DesktopLeaseOwner;
  readonly locality: DesktopProviderLocality;
  readonly state: DesktopLeaseState;
}

/**
 * Whether one more lease fits. Every lease that may still hold a desktop
 * counts, `release-failed` included: that desktop may still be running.
 */
export function desktopLeaseFits(input: {
  readonly holdings: ReadonlyArray<DesktopLeaseHolding>;
  readonly owner: DesktopLeaseOwner;
  readonly locality: DesktopProviderLocality;
}): boolean {
  const live = input.holdings.filter((holding) => desktopLeaseHoldsDesktop(holding.state));
  const threadLeases = live.filter(
    (holding) => String(holding.owner.threadId) === String(input.owner.threadId),
  ).length;
  if (threadLeases >= DESKTOP_LEASE_CAPS.perThread) return false;
  if (input.locality !== "host-local") return true;
  const hostLocal = live.filter((holding) => holding.locality === "host-local").length;
  return hostLocal < DESKTOP_LEASE_CAPS.hostLocalPerHost;
}

/**
 * Whether a ready lease's own clock has ended it. Idle applies only when no
 * Desktop tab is open and neither operator has acted for the recipe's idle
 * minutes. Times are epoch milliseconds.
 */
export function desktopLeaseClockEnds(input: {
  readonly now: number;
  readonly expiresAt: number;
  readonly idleMinutes: number;
  readonly lastActivityAt: number;
  readonly openTabs: number;
}): Extract<DesktopLeaseEndReason, "expired" | "idle"> | undefined {
  if (input.now >= input.expiresAt) return "expired";
  if (input.openTabs > 0) return undefined;
  if (input.now - input.lastActivityAt >= input.idleMinutes * 60_000) return "idle";
  return undefined;
}

export type DesktopLeaseExtensionDecision =
  | { readonly kind: "allowed"; readonly expiresAt: number }
  | { readonly kind: "refused"; readonly reason: "agent-cannot-extend" | "beyond-maximum" };

/** Only a person extends, and never past the recipe maximum. */
export function decideDesktopLeaseExtension(input: {
  readonly actor: EventActor["kind"];
  readonly expiresAt: number;
  readonly maximumExpiresAt: number;
  readonly byMinutes: number;
}): DesktopLeaseExtensionDecision {
  if (input.actor !== "local-user" && input.actor !== "remote-device") {
    return { kind: "refused", reason: "agent-cannot-extend" };
  }
  if (!Number.isSafeInteger(input.byMinutes) || input.byMinutes < 1) {
    return { kind: "refused", reason: "beyond-maximum" };
  }
  const expiresAt = input.expiresAt + input.byMinutes * 60_000;
  if (expiresAt > input.maximumExpiresAt) return { kind: "refused", reason: "beyond-maximum" };
  return { kind: "allowed", expiresAt };
}

/**
 * Whether the provider's own clock stops a desktop no earlier than the lease
 * does. A billed desktop without one could outlive a host that never comes
 * back, so the host refuses to keep it.
 */
export function desktopProviderExpiryHolds(input: {
  readonly billed: boolean;
  readonly expiresAt: number;
  readonly providerExpiresAt: number | undefined;
}): boolean {
  if (!input.billed) return true;
  return input.providerExpiresAt !== undefined && input.providerExpiresAt >= input.expiresAt;
}
