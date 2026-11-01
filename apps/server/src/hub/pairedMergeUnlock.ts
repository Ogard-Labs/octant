// The owner unlock a host may ask for before a paired phone or web client
// merges. A paired client is a product principal with its own device session;
// an owner device is a hub member with an unlock key; nothing on the host ties
// the two together. So the host asks the merge for what an owner action needs:
// a challenge the owner route issued to an owner on this host's own list, for
// the merge route's own method, path, and body hash, answered by that owner's
// unlock key. The switch is off by default, so no paired client is locked out
// until the person turns it on in a window on this host.

import {
  HubMemberId,
  type AuditActingPrincipal,
  type CodeOwnerMergeUnlockReason,
  type CodeOwnerMergeUnlockRefusal,
  type HubMembershipChangedPayload,
} from "@octant/contracts";
import { Schema } from "effect";
import { authorizeOwnerRequest } from "@octant/domain";
import { ownerScopeFor, readUnlockProofHeader, type HubOwnerRouteOptions } from "./hubOwnerRoutes";
import type { HubStatePort } from "./hubStateStore";
import { ownerEntries } from "./ownerRecords";
import type { OwnerUnlockService } from "./ownerUnlock";

const decodeHubMemberId = Schema.decodeUnknownSync(HubMemberId);

export type PairedMergeUnlockCheck =
  | { readonly status: "unlocked"; readonly ownerMemberId: HubMemberId }
  | CodeOwnerMergeUnlockRefusal;

/** What the Code merge routes ask of the hub side. */
export interface PairedMergeUnlockPort {
  /** Whether a paired client's merge needs an owner unlock on this host. */
  readonly required: () => boolean;
  /** Checks the unlock a paired client's merge carries, before any side effect. */
  readonly verify: (request: {
    readonly path: string;
    readonly body: string;
    readonly proof: string | null;
  }) => PairedMergeUnlockCheck;
}

/** The Code routes are wired before the hub side, so they reach it through this slot. */
export interface PairedMergeUnlockSlot {
  readonly current: () => PairedMergeUnlockPort | undefined;
  readonly bind: (port: PairedMergeUnlockPort) => void;
}

export function createPairedMergeUnlockSlot(): PairedMergeUnlockSlot {
  let bound: PairedMergeUnlockPort | undefined;
  return {
    current: () => bound,
    bind: (port) => {
      bound = port;
    },
  };
}

export type PairedMergeUnlockSwitchOutcome = {
  readonly status: "changed";
  readonly enabled: boolean;
};

export class PairedMergeUnlockService implements PairedMergeUnlockPort {
  readonly #state: HubStatePort;
  readonly #owners: Pick<HubOwnerRouteOptions, "hub" | "spoke">;
  readonly #unlock: OwnerUnlockService;
  readonly #record: (change: HubMembershipChangedPayload) => void;

  constructor(options: {
    readonly state: HubStatePort;
    readonly hub: HubOwnerRouteOptions["hub"];
    readonly spoke: HubOwnerRouteOptions["spoke"];
    readonly unlock: OwnerUnlockService;
    readonly record: (change: HubMembershipChangedPayload) => void;
  }) {
    this.#state = options.state;
    this.#owners = { hub: options.hub, spoke: options.spoke };
    this.#unlock = options.unlock;
    this.#record = options.record;
  }

  required(): boolean {
    return this.#state.load().ownerUnlockBeforePairedMerge === true;
  }

  /** Only a window on this host reaches this; the caller has checked. */
  setRequired(enabled: boolean, principal: AuditActingPrincipal): PairedMergeUnlockSwitchOutcome {
    const { ownerUnlockBeforePairedMerge: _previous, ...rest } = this.#state.load();
    this.#state.save(enabled ? { ...rest, ownerUnlockBeforePairedMerge: true } : rest);
    this.#record({
      change: enabled ? "paired-merge-unlock-on" : "paired-merge-unlock-off",
      actingPrincipal: principal,
    });
    return { status: "changed", enabled };
  }

  verify(request: {
    readonly path: string;
    readonly body: string;
    readonly proof: string | null;
  }): PairedMergeUnlockCheck {
    const scope = ownerScopeFor(this.#owners, request.path);
    if ("kind" in scope) return { status: "owner-unlock-required", reason: "no-owner-list" };
    const hostMemberId = decodeHubMemberId(this.#owners.hub.hubMemberId());
    const refuse = (reason: CodeOwnerMergeUnlockReason): CodeOwnerMergeUnlockRefusal => ({
      status: "owner-unlock-required",
      reason,
      hostMemberId,
    });
    if (request.proof === null) return refuse("missing");
    const proof = readUnlockProofHeader(request.proof);
    if (proof === undefined) return refuse("invalid");
    // The challenge is consumed here whatever follows, so one unlock opens at most one merge.
    const answered = this.#unlock.verifyIssued({
      proof,
      request: { method: "POST", path: request.path, body: request.body },
      unlockKeyFor: (memberId) =>
        scope.owners.find((entry) => String(entry.memberId) === memberId)?.unlockPublicKey,
    });
    if (answered.status === "refused") return refuse(answered.kind);
    const owner = scope.owners.find((entry) => String(entry.memberId) === answered.ownerMemberId);
    if (owner === undefined) return refuse("not-an-owner");
    if (scope.inactiveDeviceMemberIds.includes(answered.ownerMemberId)) {
      this.#unlock.revokeOwner(answered.ownerMemberId);
      return refuse("device-revoked");
    }
    // The same rule an owner action meets on the owner route: the Owners grant
    // item on a spoke, never the hub's own member, and the owner's identity key
    // matching the roster it was confirmed against.
    const decision = authorizeOwnerRequest({
      host: scope.host,
      grant: scope.grant,
      owners: ownerEntries(scope.owners),
      roster: scope.roster,
      memberId: owner.memberId,
      identityKeyFingerprint: owner.identityKeyFingerprint,
      unlock: "fresh",
      unlockClass: "own",
    });
    if (decision.status === "refused") {
      return refuse(
        decision.kind === "hub-principal" || decision.kind === "owners-not-honored"
          ? decision.kind
          : "not-an-owner",
      );
    }
    this.#record({
      change: "owner-merge-unlocked",
      actingPrincipal: { kind: "owner-unlock", memberId: owner.memberId },
      memberId: owner.memberId,
    });
    return { status: "unlocked", ownerMemberId: owner.memberId };
  }
}
