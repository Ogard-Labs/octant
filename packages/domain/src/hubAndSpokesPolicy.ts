import type {
  AgentProfileId,
  DelegatedAuthority,
  DelegationRequest,
  HostOwnerEntry,
  HubMemberId,
  HubRoster,
  NewMemberConfirmation,
  PeerDelegationMode,
  PeerDelegationPosture,
  PeerGrant,
  ProjectId,
  RosterMember,
  SignedHubRoster,
} from "@octant/contracts";

const postureRank: Record<PeerDelegationPosture, number> = {
  plan: 0,
  "approval-gated": 1,
  "full-access": 2,
};

const narrowerPosture = (
  a: PeerDelegationPosture,
  b: PeerDelegationPosture,
): PeerDelegationPosture => (postureRank[a] <= postureRank[b] ? a : b);

type BrandedId = HubMemberId | ProjectId | AgentProfileId;

const sameId = (a: BrandedId, b: BrandedId): boolean => String(a) === String(b);

const includesId = (ids: ReadonlyArray<BrandedId>, id: BrandedId): boolean =>
  ids.some((candidate) => sameId(candidate, id));

/** A roster member the receiving spoke has a peer grant for. */
export type AuthorizedPeer = {
  readonly member: RosterMember;
  readonly grant: PeerGrant;
};

export type PeerAuthorization =
  | ({ readonly status: "authorized" } & AuthorizedPeer)
  | { readonly status: "refused"; readonly kind: "not-in-roster" | "no-peer-grant" };

/**
 * A member authorizes nothing by being in the roster. The roster says who the
 * hub vouches for; only a peer grant the receiving spoke gave says what that
 * member may do there.
 */
export function authorizePeer(input: {
  readonly roster: HubRoster;
  readonly grants: ReadonlyArray<PeerGrant>;
  readonly memberId: HubMemberId;
}): PeerAuthorization {
  const member = input.roster.members.find((entry) => sameId(entry.memberId, input.memberId));
  if (member === undefined) return { status: "refused", kind: "not-in-roster" };
  const grant = input.grants.find((entry) => sameId(entry.memberId, input.memberId));
  if (grant === undefined) return { status: "refused", kind: "no-peer-grant" };
  return { status: "authorized", member, grant };
}

/** What the receiving spoke's own Project allows, whatever any peer asks for. */
export type DelegationProjectAuthority = {
  readonly projectId: ProjectId;
  readonly modes: ReadonlyArray<PeerDelegationMode>;
  /** `full-access` only when the Project itself allows Full access. */
  readonly ceiling: PeerDelegationPosture;
};

export type DelegationClamp =
  | { readonly status: "clamped"; readonly authority: DelegatedAuthority }
  | {
      readonly status: "refused";
      readonly kind:
        | "guest-cannot-delegate"
        | "delegation-not-granted"
        | "project-mismatch"
        | "project-not-granted"
        | "mode-not-granted"
        | "profile-not-granted";
    };

/**
 * The authority a delegated run gets: the request, narrowed to the smaller of
 * the peer grant and the receiving Project. It never widens. Full access needs
 * an owner's recorded choice for this Project on the peer grant and a Project
 * that allows it; either one missing narrows the run to approval-gated.
 */
export function clampDelegation(input: {
  readonly peer: AuthorizedPeer;
  readonly request: DelegationRequest;
  readonly project: DelegationProjectAuthority;
}): DelegationClamp {
  const { peer, request, project } = input;
  if (peer.member.role === "guest") return { status: "refused", kind: "guest-cannot-delegate" };
  const delegation = peer.grant.delegation;
  if (delegation === undefined) return { status: "refused", kind: "delegation-not-granted" };
  if (!sameId(request.projectId, project.projectId)) {
    return { status: "refused", kind: "project-mismatch" };
  }
  if (delegation.projects !== "all" && !includesId(delegation.projects, project.projectId)) {
    return { status: "refused", kind: "project-not-granted" };
  }
  const { mode, profileId } = request.authority;
  if (!delegation.modes.includes(mode) || !project.modes.includes(mode)) {
    return { status: "refused", kind: "mode-not-granted" };
  }
  const profileAllowed =
    profileId === undefined
      ? delegation.providerProfiles.allowDefault
      : includesId(delegation.providerProfiles.profileIds, profileId);
  if (!profileAllowed) return { status: "refused", kind: "profile-not-granted" };

  const grantCeiling: PeerDelegationPosture =
    delegation.fullAccess !== undefined &&
    includesId(delegation.fullAccess.projects, project.projectId)
      ? "full-access"
      : delegation.posture;
  const posture = narrowerPosture(
    request.authority.posture,
    narrowerPosture(grantCeiling, project.ceiling),
  );
  return {
    status: "clamped",
    authority: profileId === undefined ? { mode, posture } : { mode, posture, profileId },
  };
}

export type RosterReplacement =
  | { readonly status: "accepted" }
  | {
      readonly status: "refused";
      readonly kind:
        | "signature-invalid"
        | "stale-sequence"
        | "signer-not-hub"
        | "standby-not-named"
        | "hub-reachable"
        | "standby-changed-standby-order"
        | "standby-changed-hub-roles";
    };

const hubRoleEntries = (roster: HubRoster): ReadonlyArray<string> =>
  roster.members
    .filter((member) => member.role === "hub" || member.role === "standby-hub")
    .map((member) => `${String(member.memberId)}:${member.role}`)
    .sort();

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Whether a member replaces the roster it holds with a candidate. The caller
 * checks the signature against the signer's key and says so in
 * `signatureVerified`; this decides everything else.
 *
 * - An older or equal sequence never replaces a newer one.
 * - A hub-signed roster must come from the hub the latest hub-signed roster
 *   names.
 * - A standby-signed roster is accepted only from a standby the latest
 *   hub-signed roster names, only while the member cannot reach the hub, and
 *   only if it leaves the standby order and every hub and standby role as the
 *   hub signed them.
 */
export function decideRosterReplacement(input: {
  readonly held: {
    readonly latest?: SignedHubRoster;
    readonly latestHubSigned?: SignedHubRoster;
  };
  readonly candidate: SignedHubRoster;
  readonly signatureVerified: boolean;
  readonly hubReachable: boolean;
}): RosterReplacement {
  const { held, candidate } = input;
  if (!input.signatureVerified) return { status: "refused", kind: "signature-invalid" };
  if (held.latest !== undefined && candidate.roster.sequence <= held.latest.roster.sequence) {
    return { status: "refused", kind: "stale-sequence" };
  }
  const anchor = held.latestHubSigned;
  if (candidate.signedBy.kind === "hub") {
    const hub = anchor?.roster.members.find((member) => member.role === "hub");
    if (hub !== undefined && !sameId(hub.memberId, candidate.signedBy.memberId)) {
      return { status: "refused", kind: "signer-not-hub" };
    }
    return { status: "accepted" };
  }
  if (anchor === undefined) return { status: "refused", kind: "standby-not-named" };
  const named =
    includesId(anchor.roster.standbyOrder, candidate.signedBy.memberId) &&
    anchor.roster.members.some(
      (member) =>
        sameId(member.memberId, candidate.signedBy.memberId) && member.role === "standby-hub",
    );
  if (!named) return { status: "refused", kind: "standby-not-named" };
  if (input.hubReachable) return { status: "refused", kind: "hub-reachable" };
  if (
    !sameList(anchor.roster.standbyOrder.map(String), candidate.roster.standbyOrder.map(String))
  ) {
    return { status: "refused", kind: "standby-changed-standby-order" };
  }
  if (!sameList(hubRoleEntries(anchor.roster), hubRoleEntries(candidate.roster))) {
    return { status: "refused", kind: "standby-changed-hub-roles" };
  }
  return { status: "accepted" };
}

/** The membership changes a standby made while standing in, in the order it made them. */
export type StandInMembershipChanges = {
  readonly sequence: number;
  readonly added: ReadonlyArray<RosterMember>;
  readonly removed: ReadonlyArray<HubMemberId>;
};

/**
 * The roster the hub signs next when a standby stands down. `hub` is the
 * hub's roster now, `hubRemovedSinceBase` every member the hub removed since
 * the stand-in began, and `standby` the changes the standby hands back.
 * Removals are passed as change lists rather than read off snapshots, because
 * a member added during the stand-in and removed by the other side is absent
 * from the start roster, so no comparison of snapshots can tell that removal
 * from a member that side never saw. A member removed by either side stays
 * removed. The standby order is the hub's.
 */
export function mergeStandInMembership(input: {
  readonly hub: HubRoster;
  readonly hubRemovedSinceBase: ReadonlyArray<HubMemberId>;
  readonly standby: StandInMembershipChanges;
}): HubRoster {
  const { hub, standby } = input;
  const removals = [...input.hubRemovedSinceBase, ...standby.removed];
  const removed = (id: HubMemberId) => includesId(removals, id);
  const joined = standby.added.filter(
    (member) => !hub.members.some((entry) => sameId(entry.memberId, member.memberId)),
  );
  const members = [...hub.members, ...joined].filter((member) => !removed(member.memberId));
  return {
    sequence: Math.max(hub.sequence, standby.sequence) + 1,
    members,
    standbyOrder: hub.standbyOrder.filter((id) =>
      members.some((member) => sameId(member.memberId, id)),
    ),
    failoverAfterSeconds: hub.failoverAfterSeconds,
  };
}

export type HeldGrantReconciliation = {
  readonly kept: ReadonlyArray<PeerGrant>;
  readonly dropped: ReadonlyArray<PeerGrant>;
};

/**
 * Grants held for a member end when a newer roster no longer lists it, whether
 * it left or was removed. With no newer roster (the hub is merely unreachable)
 * every grant stays.
 */
export function reconcileHeldGrants(input: {
  readonly grants: ReadonlyArray<PeerGrant>;
  readonly held: HubRoster;
  readonly newer?: HubRoster;
}): HeldGrantReconciliation {
  const { newer } = input;
  if (newer === undefined || newer.sequence <= input.held.sequence) {
    return { kept: input.grants, dropped: [] };
  }
  const listed = (grant: PeerGrant) =>
    newer.members.some((member) => sameId(member.memberId, grant.memberId));
  return {
    kept: input.grants.filter(listed),
    dropped: input.grants.filter((grant) => !listed(grant)),
  };
}

/** The grant a new full member gets (decision H2). */
export function fullMemberPeerGrant(member: RosterMember): PeerGrant {
  if (member.role === "guest") {
    return { memberId: member.memberId, readStatus: true, answerApprovals: true };
  }
  return {
    memberId: member.memberId,
    readStatus: true,
    delegation: {
      projects: "all",
      modes: ["work", "code"],
      posture: "approval-gated",
      providerProfiles: { allowDefault: true, profileIds: [] },
    },
  };
}

/** The grant a member holds until confirmed, when Confirm new members is on. */
export function statusOnlyPeerGrant(member: RosterMember): PeerGrant {
  return { memberId: member.memberId, readStatus: true };
}

export type NewMemberAdmission =
  | { readonly status: "full-member"; readonly grant: PeerGrant }
  | {
      readonly status: "status-only";
      readonly kind: "awaiting-confirmation" | "confirmation-invalid";
      readonly reason?:
        | "wrong-spoke"
        | "wrong-member"
        | "wrong-key"
        | "not-an-owner"
        | "signature-invalid";
      readonly grant: PeerGrant;
    };

/**
 * A new member is a full member unless the spoke has Confirm new members on.
 * Then it stays status-only until an owner on the spoke's own owner list has
 * signed a confirmation naming this spoke, this member, and this identity key.
 * The caller verifies the signature with the owner's unlock key.
 */
export function admitNewMember(input: {
  readonly spokeId: HubMemberId;
  readonly member: RosterMember;
  readonly confirmNewMembers: boolean;
  readonly owners: ReadonlyArray<HostOwnerEntry>;
  readonly confirmation?: {
    readonly confirmation: NewMemberConfirmation;
    readonly signatureVerified: boolean;
  };
}): NewMemberAdmission {
  const { member } = input;
  if (!input.confirmNewMembers) {
    return { status: "full-member", grant: fullMemberPeerGrant(member) };
  }
  const held = statusOnlyPeerGrant(member);
  if (input.confirmation === undefined) {
    return { status: "status-only", kind: "awaiting-confirmation", grant: held };
  }
  const { confirmation, signatureVerified } = input.confirmation;
  const owner = input.owners.find((entry) => sameId(entry.memberId, confirmation.confirmedBy));
  const invalid = (
    reason: "wrong-spoke" | "wrong-member" | "wrong-key" | "not-an-owner" | "signature-invalid",
  ): NewMemberAdmission => ({
    status: "status-only",
    kind: "confirmation-invalid",
    reason,
    grant: held,
  });
  if (!sameId(confirmation.spokeId, input.spokeId)) return invalid("wrong-spoke");
  if (!sameId(confirmation.memberId, member.memberId)) return invalid("wrong-member");
  if (confirmation.identityKeyFingerprint !== member.identityKeyFingerprint) {
    return invalid("wrong-key");
  }
  if (owner === undefined || owner.unlockKeyFingerprint !== confirmation.unlockKeyFingerprint) {
    return invalid("not-an-owner");
  }
  if (!signatureVerified) return invalid("signature-invalid");
  return { status: "full-member", grant: fullMemberPeerGrant(member) };
}

export type OwnerHonoring =
  | { readonly status: "owner"; readonly entry: HostOwnerEntry }
  | {
      readonly status: "not-owner";
      readonly kind: "not-on-owner-list" | "identity-mismatch" | "not-in-roster";
    };

/**
 * A host honors an owner only if the member is on that host's own owner list
 * with the identity key it presents, and the held roster still lists it. The
 * roster's owner mark is never read: a hub that marks a member as an owner
 * changes nothing here.
 */
export function honorOwner(input: {
  readonly owners: ReadonlyArray<HostOwnerEntry>;
  readonly roster: HubRoster;
  readonly memberId: HubMemberId;
  readonly identityKeyFingerprint: string;
}): OwnerHonoring {
  const entry = input.owners.find((owner) => sameId(owner.memberId, input.memberId));
  if (entry === undefined) return { status: "not-owner", kind: "not-on-owner-list" };
  if (entry.identityKeyFingerprint !== input.identityKeyFingerprint) {
    return { status: "not-owner", kind: "identity-mismatch" };
  }
  if (!input.roster.members.some((member) => sameId(member.memberId, input.memberId))) {
    return { status: "not-owner", kind: "not-in-roster" };
  }
  return { status: "owner", entry };
}
