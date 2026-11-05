import type { AuditActingPrincipal, HubMemberId } from "@octant/contracts";
import type { OwnerBrowserRefusal, OwnerBrowserTarget } from "@octant/contracts/owner-browser";

type Decision =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly reason: OwnerBrowserRefusal };
type Admission = {
  readonly principal: AuditActingPrincipal;
  readonly ownerCurrent: boolean;
  readonly resourceCurrent: boolean;
  readonly privateHeld: boolean;
};

function admission(input: Admission): Decision {
  if (input.principal.kind !== "owner-unlock" || !input.ownerCurrent)
    return { status: "refused", reason: "unauthorized" };
  if (!input.resourceCurrent) return { status: "refused", reason: "stale-target" };
  if (input.privateHeld) return { status: "refused", reason: "private-held" };
  return { status: "allowed" };
}

export function decideOwnerBrowserTakeOver(
  input: Admission & {
    readonly freshOwnUnlock: boolean;
    readonly controllerBusy: boolean;
  },
): Decision {
  const current = admission(input);
  if (current.status === "refused") return current;
  if (!input.freshOwnUnlock) return { status: "refused", reason: "unlock-required" };
  if (input.controllerBusy) return { status: "refused", reason: "controller-busy" };
  return { status: "allowed" };
}

export function sameOwnerBrowserTarget(a: OwnerBrowserTarget, b: OwnerBrowserTarget): boolean {
  return (
    String(a.hostMemberId) === String(b.hostMemberId) &&
    String(a.contextId) === String(b.contextId) &&
    String(a.threadId) === String(b.threadId) &&
    a.targetVersion === b.targetVersion &&
    a.documentRevision === b.documentRevision &&
    a.origin === b.origin &&
    a.profile === b.profile
  );
}

export function decideOwnerBrowserUse(
  input: Admission & {
    readonly ownerMemberId: HubMemberId;
    readonly now: number;
    readonly expiresAt: number;
    readonly target: OwnerBrowserTarget;
    readonly currentTarget: OwnerBrowserTarget;
    readonly sequence: number;
    readonly expectedSequence: number;
    readonly expectedFrame?: number;
    readonly currentFrame: number;
  },
): Decision {
  const current = admission(input);
  if (current.status === "refused") return current;
  if (
    input.principal.kind !== "owner-unlock" ||
    String(input.principal.memberId) !== String(input.ownerMemberId)
  )
    return { status: "refused", reason: "unauthorized" };
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.expiresAt) ||
    input.now >= input.expiresAt
  )
    return { status: "refused", reason: "expired" };
  if (!sameOwnerBrowserTarget(input.target, input.currentTarget))
    return { status: "refused", reason: "stale-target" };
  if (input.sequence !== input.expectedSequence)
    return { status: "refused", reason: "stale-sequence" };
  if (
    input.expectedFrame !== undefined &&
    (input.expectedFrame === 0 || input.expectedFrame !== input.currentFrame)
  )
    return { status: "refused", reason: "stale-frame" };
  return { status: "allowed" };
}
