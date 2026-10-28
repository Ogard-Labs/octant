import type {
  DesktopArtifactRefusalReason,
  DesktopInputEvent,
  DesktopLeaseEndReason,
  DesktopLeaseOperation,
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

/**
 * Whether a recipe on these terms may give its desktop network. A host-local
 * desktop gets network only by sharing the host's namespace, which reaches
 * the Octant server. No placement offers network yet: every placement offered
 * is a VM whose user networking can reach the loopback of the machine it runs
 * on, which on this computer holds the Octant server and on another of the
 * person's machines holds their own services there. So only a provider with
 * no placements, running off this computer, may allow it.
 */
export function desktopNetworkAllowed(input: {
  readonly locality: DesktopProviderLocality;
  readonly placed: boolean;
}): boolean {
  return input.locality === "cloud" && !input.placed;
}

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
  /**
   * `in-thread` asks under ordinary posture rules; `billed` and `off-machine`
   * need a person every time.
   */
  | { readonly kind: "ask"; readonly asks: "in-thread" | "billed" | "off-machine" };

/**
 * Plan refuses. A billed provider spends the person's money, which no posture
 * covers, so a person confirms every billed lease even under Full access. A
 * desktop off this machine runs somewhere the person should know of before
 * it starts, and can outlive this host, so a person confirms every one of
 * those too, their own Start included. A person acquiring a host-local
 * desktop has already decided; an agent asks unless the thread runs with
 * Full access.
 */
export function decideDesktopLeaseAcquire(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly billed: boolean;
  readonly locality: DesktopProviderLocality;
  readonly initiator: EventActor["kind"];
}): DesktopLeaseAcquireGate {
  if (input.executionPolicy === "plan") return { kind: "refused", reason: "plan-mode" };
  if (input.billed) return { kind: "ask", asks: "billed" };
  if (input.locality !== "host-local") return { kind: "ask", asks: "off-machine" };
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
 * back, so the host refuses to keep it. The one exception is a billed
 * placement that declares how long its provider bills once the host stops:
 * the person confirmed that worst case before it started, and the spend
 * estimate reserved it against the month's cap.
 */
export function desktopProviderExpiryHolds(input: {
  readonly billed: boolean;
  readonly expiresAt: number;
  readonly providerExpiresAt: number | undefined;
  readonly billedIfHostStopsMinutes?: number | undefined;
}): boolean {
  if (!input.billed) return true;
  if (input.billedIfHostStopsMinutes !== undefined) return true;
  return input.providerExpiresAt !== undefined && input.providerExpiresAt >= input.expiresAt;
}

/**
 * The calendar month a billed desktop's spend counts toward: UTC, the month
 * the cloud providers a desktop runs on bill by, so a lease never counts
 * toward a month that depends on where the host happens to be.
 */
export function desktopSpendMonth(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 7);
}

/**
 * The most a billed lease could spend, in whole cents rounded up: the
 * person's hourly cost times the longer of the recipe's maximum lease and
 * how long the provider bills a desktop this host can no longer end.
 */
export function desktopLeaseSpendEstimate(input: {
  readonly hourlyCostUsdCents: number;
  readonly maximumLeaseMinutes: number;
  readonly billedIfHostStopsMinutes?: number | undefined;
}): number {
  const minutes = Math.max(input.maximumLeaseMinutes, input.billedIfHostStopsMinutes ?? 0);
  return Math.ceil((input.hourlyCostUsdCents * minutes) / 60);
}

export interface DesktopSpendHolding {
  readonly state: DesktopLeaseState;
  /** Epoch milliseconds the lease was journaled. */
  readonly requestedAt: number;
  /** Epoch milliseconds of the lease's last transition. */
  readonly updatedAt: number;
  readonly spend?: { readonly hourlyCostUsdCents: number; readonly estimateUsdCents: number };
  /**
   * A desktop made for the lease that the host has not yet verified gone,
   * such as one left by an acquire that failed after the provider created it.
   */
  readonly unverifiedDesktop?: boolean;
}

/**
 * What one billed lease counts against its month. A lease that may still
 * hold a desktop counts its whole estimate, because the host cannot know it
 * stops billing sooner; so does a refused or failed one whose leftover
 * desktop is not yet verified gone, or another billed lease could take the
 * room it may still be spending. One verified gone, or never made, counts the
 * time from its request to its end at the hourly cost, rounded up and never
 * more than its estimate.
 */
export function desktopLeaseSpent(holding: DesktopSpendHolding): number {
  const { spend } = holding;
  if (spend === undefined) return 0;
  if (desktopLeaseHoldsDesktop(holding.state) || holding.unverifiedDesktop === true) {
    return spend.estimateUsdCents;
  }
  const minutes = Math.max(0, holding.updatedAt - holding.requestedAt) / 60_000;
  return Math.min(spend.estimateUsdCents, Math.ceil((spend.hourlyCostUsdCents * minutes) / 60));
}

/** This month's billed spend: every lease requested in the month, each as `desktopLeaseSpent` counts it. */
export function desktopMonthSpent(input: {
  readonly holdings: ReadonlyArray<DesktopSpendHolding>;
  readonly month: string;
}): number {
  return input.holdings
    .filter((holding) => desktopSpendMonth(holding.requestedAt) === input.month)
    .reduce((total, holding) => total + desktopLeaseSpent(holding), 0);
}

export type DesktopBilledSpendDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "refused"; readonly reason: "spend-cap-unset" | "spend-cap-reached" };

/**
 * Billed desktops are off until a person sets a monthly cap. A lease starts
 * only when its whole estimate fits under the cap beside what the month has
 * already spent. Reaching the cap ends no running lease; it only refuses new
 * ones.
 */
export function decideDesktopBilledSpend(input: {
  readonly monthlyCapUsdCents: number | undefined;
  readonly spentUsdCents: number;
  readonly estimateUsdCents: number;
}): DesktopBilledSpendDecision {
  if (input.monthlyCapUsdCents === undefined) return { kind: "refused", reason: "spend-cap-unset" };
  if (input.spentUsdCents + input.estimateUsdCents > input.monthlyCapUsdCents) {
    return { kind: "refused", reason: "spend-cap-reached" };
  }
  return { kind: "proceed" };
}

/**
 * Only a person at a local window sets or clears the cap. An agent never
 * does, in any posture, so no turn can raise what it may spend; a paired
 * device does not either, as with every host-wide money setting.
 */
export function desktopSpendCapChangeAllowed(actor: EventActor["kind"]): boolean {
  return actor === "local-user";
}

export type DesktopArtifactPathDecision =
  | {
      readonly kind: "relative";
      /** The path as journaled: `/`-separated, without `.` or empty segments. */
      readonly path: string;
      readonly segments: ReadonlyArray<string>;
      /** The base name the file lands under. */
      readonly name: string;
    }
  | {
      readonly kind: "refused";
      readonly reason: Extract<
        DesktopArtifactRefusalReason,
        "path-invalid" | "path-absolute" | "path-escapes-root" | "path-in-git"
      >;
    };

/** One segment's limit in bytes, as a Linux or macOS filesystem names it. */
const MAX_NAME_BYTES = 255;
const MAX_PATH_LENGTH = 4_096;

/**
 * The checkout-relative path a transfer names, before the host touches the
 * filesystem. Any `..` is refused, even one that would land back inside the
 * root, so the journaled path is the only route to the file. `.git` is
 * matched without case because a case-insensitive volume opens `.GIT` as the
 * same directory.
 */
export function decideDesktopArtifactPath(path: string): DesktopArtifactPathDecision {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || path.includes("\0")) {
    return { kind: "refused", reason: "path-invalid" };
  }
  if (path.startsWith("/")) return { kind: "refused", reason: "path-absolute" };
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return { kind: "refused", reason: "path-escapes-root" };
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return { kind: "refused", reason: "path-in-git" };
  }
  const name = segments.at(-1);
  if (
    name === undefined ||
    segments.some((segment) => new TextEncoder().encode(segment).byteLength > MAX_NAME_BYTES)
  ) {
    return { kind: "refused", reason: "path-invalid" };
  }
  return { kind: "relative", path: segments.join("/"), segments, name };
}

export type DesktopArtifactTransferGate =
  | { readonly kind: "proceed" }
  | { readonly kind: "refused"; readonly reason: "plan-mode" }
  /** `in-thread` asks under ordinary posture rules; `off-machine` asks a person every time. */
  | { readonly kind: "ask"; readonly asks: "in-thread" | "off-machine" };

/**
 * Plan refuses. A transfer to a cloud desktop sends the file off this machine,
 * which no posture covers, so it always asks. A person sending a file to a
 * host-local desktop has already decided; an agent asks unless the thread runs
 * with Full access. Auto-accept-edits covers edits to the checkout, not
 * sending a file out of it, so it asks as approval-gated does. Once the
 * thread has read outside content, Full access no longer carries an agent's
 * transfer: it is a standing approval, and taint stops those for Computer
 * use, whose `send-file` this is.
 */
export function decideDesktopArtifactTransfer(input: {
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly locality: DesktopProviderLocality;
  readonly initiator: EventActor["kind"];
  readonly externalContentIngested: boolean;
}): DesktopArtifactTransferGate {
  if (input.executionPolicy === "plan") return { kind: "refused", reason: "plan-mode" };
  if (input.locality !== "host-local") return { kind: "ask", asks: "off-machine" };
  if (input.initiator === "local-user" || input.initiator === "remote-device") {
    return { kind: "proceed" };
  }
  if (input.executionPolicy === "full-access" && !input.externalContentIngested) {
    return { kind: "proceed" };
  }
  return { kind: "ask", asks: "in-thread" };
}

/**
 * The input a person's Desktop tab sent, as the journal names it, or
 * undefined for one it does not record. A press is journaled once, when the
 * button or key goes down; moving the pointer and letting go change nothing
 * on their own, and journaling them would write a row per pointer frame.
 */
export function desktopInputOperation(event: DesktopInputEvent): DesktopLeaseOperation | undefined {
  switch (event.kind) {
    case "pointer":
      return event.action === "down" ? "click" : undefined;
    case "key":
      return event.action === "down" ? "press" : undefined;
    case "text":
      return "type";
    case "scroll":
      return "scroll";
  }
}
