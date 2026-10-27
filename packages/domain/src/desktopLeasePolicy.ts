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
