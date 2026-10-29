import { describe, expect, it } from "vitest";
import {
  decodeDelegationRequest,
  decodePeerGrant,
  decodeSignedHubRoster,
  type DelegationRequest,
  type HostOwnerEntry,
  type HubMemberId,
  type HubRoster,
  type NewMemberConfirmation,
  type PeerGrant,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  admitNewMember,
  authorizeHubRequest,
  authorizeOwnerRequest,
  authorizePeer,
  clampDelegation,
  decideRosterReplacement,
  decideStandIn,
  decideStandInHandback,
  defaultHubGrant,
  delegationPostureWithin,
  honorOwner,
  hubRosterSigningPayload,
  mergeStandInMembership,
  newMemberConfirmationSigningPayload,
  orderStandbys,
  OWNER_UNLOCK_LIFETIME_MS,
  ownerUnlockSigningPayload,
  reconcileHeldGrants,
  rosterMemberWebOrigin,
  type StandInMembershipChanges,
} from "./hubAndSpokesPolicy";

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const memberId = (n: number) => id(n) as HubMemberId;
const hub = id(1);
const laptop = id(3);
const phone = id(4);
const project = id(6);
const otherProject = id(7);
const thread = id(8);
const profile = id(9);
const key = (n: number) => String(n).repeat(64).slice(0, 64);

const member = (n: number, role: RosterMember["role"], owner = false): RosterMember => ({
  memberId: memberId(n),
  name: `member ${n}`,
  role,
  identityKeyFingerprint: key(n),
  listenerPin: key(n),
  privateNames: [],
  addresses: ["100.64.0.1"],
  owner,
});

const roster = (
  sequence: number,
  members: ReadonlyArray<RosterMember>,
  standbyOrder: ReadonlyArray<number> = [2],
): HubRoster => ({
  sequence,
  members,
  standbyOrder: standbyOrder.map(memberId),
  failoverAfterSeconds: 300,
});

const baseMembers = [
  member(1, "hub"),
  member(2, "standby-hub"),
  member(3, "spoke"),
  member(4, "guest"),
];

const signed = (
  body: HubRoster,
  kind: "hub" | "standby" = "hub",
  signer: number = kind === "hub" ? 1 : 2,
): SignedHubRoster =>
  decodeSignedHubRoster({
    roster: body,
    signedBy: { kind, memberId: id(signer) },
    signature: "c2lnbmF0dXJl",
  });

const grant = (overrides: Record<string, unknown> = {}): PeerGrant =>
  decodePeerGrant({
    memberId: laptop,
    readStatus: true,
    delegation: {
      projects: "all",
      modes: ["work", "code"],
      posture: "approval-gated",
      providerProfiles: { allowDefault: true, profileIds: [] },
      ...overrides,
    },
  });

const request = (authority: Record<string, unknown> = {}): DelegationRequest =>
  decodeDelegationRequest({
    requestId: id(9),
    projectId: project,
    task: "Run the tests",
    authority: { mode: "code", posture: "approval-gated", ...authority },
    delegatedFrom: { kind: "code", memberId: hub, threadId: thread },
  });

const projectAuthority = {
  projectId: project as DelegationRequest["projectId"],
  modes: ["work", "code"] as const,
  ceiling: "full-access" as const,
};

const peerFor = (grantValue: PeerGrant, role: RosterMember["role"] = "spoke") => ({
  member: { ...member(3, role) },
  grant: grantValue,
});

const clampPosture = (
  grantValue: PeerGrant,
  posture: string,
  ceiling: "plan" | "approval-gated" | "full-access" = "full-access",
) => {
  const result = clampDelegation({
    peer: peerFor(grantValue),
    request: request({ posture }),
    project: { ...projectAuthority, ceiling },
  });
  return result.status === "clamped" ? result.authority.posture : result.kind;
};

describe("clampDelegation", () => {
  it("never widens a request past the peer grant", () => {
    expect(clampPosture(grant(), "full-access")).toBe("approval-gated");
    expect(clampPosture(grant({ posture: "plan" }), "approval-gated")).toBe("plan");
    expect(clampPosture(grant(), "plan")).toBe("plan");
  });

  it("never widens a request past the receiving Project", () => {
    expect(clampPosture(grant(), "approval-gated", "plan")).toBe("plan");
    const owned = grant({
      fullAccess: { chosenBy: phone, chosenAt: "2026-10-28T10:00:00.000Z", projects: [project] },
    });
    expect(clampPosture(owned, "full-access", "approval-gated")).toBe("approval-gated");
  });

  it("grants Full access only when an owner chose it for this Project and the Project allows it", () => {
    const owned = grant({
      fullAccess: { chosenBy: phone, chosenAt: "2026-10-28T10:00:00.000Z", projects: [project] },
    });
    expect(clampPosture(owned, "full-access")).toBe("full-access");
    const otherOnly = grant({
      fullAccess: {
        chosenBy: phone,
        chosenAt: "2026-10-28T10:00:00.000Z",
        projects: [otherProject],
      },
    });
    expect(clampPosture(otherOnly, "full-access")).toBe("approval-gated");
  });

  it("keeps the requested profile and mode when the grant allows them", () => {
    const result = clampDelegation({
      peer: peerFor(grant({ providerProfiles: { allowDefault: false, profileIds: [profile] } })),
      request: request({ profileId: profile }),
      project: projectAuthority,
    });
    expect(result).toEqual({
      status: "clamped",
      authority: { mode: "code", posture: "approval-gated", profileId: profile },
    });
  });

  it("refuses a Project, mode, or profile the grant does not name", () => {
    const refusal = (g: PeerGrant, r = request()) => {
      const result = clampDelegation({ peer: peerFor(g), request: r, project: projectAuthority });
      return result.status === "refused" ? result.kind : result.status;
    };
    expect(refusal(grant({ projects: [otherProject] }))).toBe("project-not-granted");
    expect(refusal(grant({ modes: ["work"] }))).toBe("mode-not-granted");
    expect(refusal(grant({ providerProfiles: { allowDefault: false, profileIds: [] } }))).toBe(
      "profile-not-granted",
    );
    expect(refusal(grant(), request({ profileId: profile }))).toBe("profile-not-granted");
  });

  it("refuses a mode the receiving Project does not run", () => {
    const result = clampDelegation({
      peer: peerFor(grant()),
      request: request({ mode: "code" }),
      project: { ...projectAuthority, modes: ["work"] },
    });
    expect(result).toEqual({ status: "refused", kind: "mode-not-granted" });
  });

  it("refuses a grant without delegation and a guest that holds one", () => {
    const noDelegation = decodePeerGrant({ memberId: laptop, readStatus: true });
    expect(
      clampDelegation({
        peer: peerFor(noDelegation),
        request: request(),
        project: projectAuthority,
      }),
    ).toEqual({ status: "refused", kind: "delegation-not-granted" });
    expect(
      clampDelegation({
        peer: peerFor(grant(), "guest"),
        request: request(),
        project: projectAuthority,
      }),
    ).toEqual({ status: "refused", kind: "guest-cannot-delegate" });
  });

  it("refuses a request that names a different Project than the one it is checked against", () => {
    expect(
      clampDelegation({
        peer: peerFor(grant()),
        request: request(),
        project: { ...projectAuthority, projectId: otherProject as DelegationRequest["projectId"] },
      }),
    ).toEqual({ status: "refused", kind: "project-mismatch" });
  });
});

describe("delegationPostureWithin", () => {
  it("lets a child run at or below the posture its parent runs at, never above", () => {
    expect(delegationPostureWithin("plan", "approval-gated")).toBe(true);
    expect(delegationPostureWithin("approval-gated", "approval-gated")).toBe(true);
    expect(delegationPostureWithin("approval-gated", "plan")).toBe(false);
    expect(delegationPostureWithin("full-access", "approval-gated")).toBe(false);
    expect(delegationPostureWithin("full-access", "full-access")).toBe(true);
  });
});

describe("authorizePeer", () => {
  const body = roster(4, baseMembers);

  it("authorizes nothing for a roster entry without a peer grant", () => {
    expect(authorizePeer({ roster: body, grants: [], memberId: memberId(3) })).toEqual({
      status: "refused",
      kind: "no-peer-grant",
    });
  });

  it("authorizes nothing for a grant whose member the roster does not list", () => {
    expect(authorizePeer({ roster: body, grants: [grant({})], memberId: memberId(5) })).toEqual({
      status: "refused",
      kind: "not-in-roster",
    });
  });

  it("authorizes a listed member that holds a peer grant", () => {
    const result = authorizePeer({ roster: body, grants: [grant()], memberId: memberId(3) });
    expect(result.status).toBe("authorized");
  });
});

describe("decideRosterReplacement", () => {
  const hubRoster = signed(roster(5, baseMembers));
  const held = { latest: hubRoster, latestHubSigned: hubRoster };
  const decide = (
    candidate: SignedHubRoster,
    overrides: Partial<Parameters<typeof decideRosterReplacement>[0]> = {},
  ) =>
    decideRosterReplacement({
      held,
      candidate,
      signatureVerified: true,
      hubReachable: true,
      ...overrides,
    });

  it("never replaces a newer roster with an older or equal one", () => {
    expect(decide(signed(roster(4, baseMembers)))).toEqual({
      status: "refused",
      kind: "stale-sequence",
    });
    expect(decide(signed(roster(5, [member(1, "hub")])))).toEqual({
      status: "refused",
      kind: "stale-sequence",
    });
  });

  it("replaces the roster with a newer one signed by the hub", () => {
    expect(decide(signed(roster(6, [...baseMembers, member(5, "spoke")])))).toEqual({
      status: "accepted",
    });
  });

  it("refuses a roster whose signature did not verify", () => {
    expect(decide(signed(roster(6, baseMembers)), { signatureVerified: false })).toEqual({
      status: "refused",
      kind: "signature-invalid",
    });
  });

  it("refuses a hub-signed roster from a member that is not the hub", () => {
    expect(decide(signed(roster(6, baseMembers), "hub", 3))).toEqual({
      status: "refused",
      kind: "signer-not-hub",
    });
  });

  it("accepts a standby-signed roster from a named standby while the hub is unreachable", () => {
    const standIn = signed(roster(6, [...baseMembers, member(5, "spoke")]), "standby");
    expect(decide(standIn, { hubReachable: false })).toEqual({ status: "accepted" });
  });

  it("refuses a standby-signed roster while the hub is reachable", () => {
    const standIn = signed(roster(6, baseMembers), "standby");
    expect(decide(standIn, { hubReachable: true })).toEqual({
      status: "refused",
      kind: "hub-reachable",
    });
  });

  it("refuses a standby-signed roster from a spoke the hub never named as standby", () => {
    const standIn = signed(roster(6, baseMembers), "standby", 3);
    expect(decide(standIn, { hubReachable: false })).toEqual({
      status: "refused",
      kind: "standby-not-named",
    });
  });

  it("refuses a standby-signed roster when the member holds no hub-signed roster", () => {
    const standIn = signed(roster(6, baseMembers), "standby");
    expect(decide(standIn, { held: {}, hubReachable: false })).toEqual({
      status: "refused",
      kind: "standby-not-named",
    });
  });

  it("refuses a stand-in that changes the standby order or promotes itself", () => {
    const reordered = signed(roster(6, baseMembers, [2, 3]), "standby");
    expect(decide(reordered, { hubReachable: false })).toEqual({
      status: "refused",
      kind: "standby-changed-standby-order",
    });
    const promoted = signed(
      roster(6, [
        member(1, "hub"),
        member(2, "standby-hub"),
        member(3, "standby-hub"),
        member(4, "guest"),
      ]),
      "standby",
    );
    expect(decide(promoted, { hubReachable: false })).toEqual({
      status: "refused",
      kind: "standby-changed-hub-roles",
    });
  });
});

describe("mergeStandInMembership", () => {
  const base = roster(5, baseMembers);
  const ids = (merged: HubRoster) => merged.members.map((entry) => String(entry.memberId));

  it("takes in members the standby added", () => {
    const merged = mergeStandInMembership({
      hub: base,
      hubRemovedSinceBase: [],
      standby: { sequence: 6, added: [member(5, "spoke")], removed: [] },
    });
    expect(ids(merged)).toContain(id(5));
    expect(merged.sequence).toBe(7);
  });

  it("lets a removal win over the other side keeping the member", () => {
    const standbyRemoved = mergeStandInMembership({
      hub: base,
      hubRemovedSinceBase: [],
      standby: { sequence: 6, added: [], removed: [memberId(4)] },
    });
    expect(ids(standbyRemoved)).not.toContain(id(4));

    const hubRemoved = mergeStandInMembership({
      hub: roster(
        6,
        baseMembers.filter((entry) => entry.role !== "spoke"),
      ),
      hubRemovedSinceBase: [memberId(3)],
      standby: { sequence: 6, added: [], removed: [] },
    });
    expect(ids(hubRemoved)).not.toContain(id(3));
  });

  it("keeps a member removed that joined during the stand-in and the hub then removed", () => {
    const merged = mergeStandInMembership({
      hub: base,
      hubRemovedSinceBase: [memberId(5)],
      standby: { sequence: 6, added: [member(5, "spoke")], removed: [] },
    });
    expect(ids(merged)).not.toContain(id(5));
  });

  it("keeps the hub's standby order and drops a removed standby from it", () => {
    const merged = mergeStandInMembership({
      hub: base,
      hubRemovedSinceBase: [],
      standby: { sequence: 6, added: [], removed: [memberId(2)] },
    });
    expect(merged.standbyOrder).toEqual([]);
  });
});

describe("decideStandInHandback", () => {
  const base = roster(5, baseMembers);
  const decide = (changes: Partial<StandInMembershipChanges>, sender = 2) =>
    decideStandInHandback({
      hub: base,
      senderMemberId: memberId(sender),
      standby: { sequence: 6, added: [], removed: [], ...changes },
    });

  it("accepts a hand-back that adds spokes and removes a spoke or a guest", () => {
    expect(decide({ added: [member(5, "spoke")], removed: [memberId(3), memberId(4)] })).toEqual({
      status: "valid",
    });
  });

  it("refuses a hand-back that removes the hub", () => {
    expect(decide({ removed: [memberId(1)] })).toEqual({
      status: "refused",
      kind: "handback-invalid",
    });
  });

  it("refuses a hand-back that removes another standby or the sender itself", () => {
    const withTwo = decideStandInHandback({
      hub: roster(
        5,
        [...baseMembers.slice(0, 3), member(5, "standby-hub"), member(4, "guest")],
        [2, 5],
      ),
      senderMemberId: memberId(2),
      standby: { sequence: 6, added: [], removed: [memberId(5)] },
    });
    expect(withTwo).toEqual({ status: "refused", kind: "handback-invalid" });
    expect(decide({ removed: [memberId(2)] })).toEqual({
      status: "refused",
      kind: "handback-invalid",
    });
  });

  it("refuses a hand-back that adds a hub, a standby, or a guest", () => {
    for (const role of ["hub", "standby-hub", "guest"] as const) {
      expect(decide({ added: [member(5, role)] })).toEqual({
        status: "refused",
        kind: "handback-invalid",
      });
    }
  });

  it("refuses a hand-back that re-adds a member the roster holds under another role", () => {
    expect(decide({ added: [member(1, "spoke")] })).toEqual({
      status: "refused",
      kind: "handback-invalid",
    });
  });
});

describe("orderStandbys", () => {
  const base = roster(5, baseMembers, [2]);
  const roles = (ordered: HubRoster) => ordered.members.map((entry) => entry.role);

  it("gives the named spokes the standby role in order and returns the others to spoke", () => {
    const result = orderStandbys({ roster: base, memberIds: [memberId(3)] });
    if (result.status !== "ordered") throw new Error(result.kind);
    expect(result.roster.standbyOrder).toEqual([memberId(3)]);
    expect(roles(result.roster)).toEqual(["hub", "spoke", "standby-hub", "guest"]);
    expect(result.roster.sequence).toBe(6);
  });

  it("clears the standbys when none are named", () => {
    const result = orderStandbys({ roster: base, memberIds: [] });
    if (result.status !== "ordered") throw new Error(result.kind);
    expect(result.roster.standbyOrder).toEqual([]);
    expect(roles(result.roster)).toEqual(["hub", "spoke", "spoke", "guest"]);
  });

  it("refuses the hub, a guest, an unknown member, and a repeated member", () => {
    const kindFor = (ids: ReadonlyArray<HubMemberId>) => {
      const result = orderStandbys({ roster: base, memberIds: ids });
      return result.status === "refused" ? result.kind : result.status;
    };
    expect(kindFor([memberId(1)])).toBe("not-a-spoke");
    expect(kindFor([memberId(4)])).toBe("not-a-spoke");
    expect(kindFor([memberId(9)])).toBe("unknown-member");
    expect(kindFor([memberId(3), memberId(3)])).toBe("duplicate-member");
  });
});

describe("decideStandIn", () => {
  const anchor = signed(roster(5, baseMembers, [2]));
  const decide = (overrides: Partial<Parameters<typeof decideStandIn>[0]> = {}) =>
    decideStandIn({
      anchor,
      selfMemberId: memberId(2),
      grant: { items: ["roster", "standby"], actProjects: [] },
      silentForMs: 300_000,
      failoverAfterMs: 300_000,
      standingIn: false,
      ...overrides,
    });
  const kind = (result: ReturnType<typeof decideStandIn>) =>
    result.status === "refused" ? result.kind : result.status;

  it("stands in for a named standby that ticked Standby after the whole failover time", () => {
    expect(kind(decide())).toBe("stand-in");
  });

  it("does not stand in for a spoke the hub did not name", () => {
    expect(kind(decide({ selfMemberId: memberId(3) }))).toBe("not-a-named-standby");
  });

  it("does not stand in without the Standby tick, before the time, or twice", () => {
    expect(kind(decide({ grant: { items: ["roster"], actProjects: [] } }))).toBe(
      "standby-not-granted",
    );
    expect(kind(decide({ silentForMs: 299_999 }))).toBe("hub-seen-recently");
    expect(kind(decide({ standingIn: true }))).toBe("already-standing-in");
    expect(kind(decide({ anchor: undefined }))).toBe("no-hub-roster");
  });
});

describe("reconcileHeldGrants", () => {
  const held = roster(5, baseMembers);
  const laptopGrant = grant();

  it("drops the grants held for a member a newer roster no longer lists", () => {
    const result = reconcileHeldGrants({
      grants: [laptopGrant],
      held,
      newer: roster(
        6,
        baseMembers.filter((entry) => entry.role !== "spoke"),
      ),
    });
    expect(result.dropped).toEqual([laptopGrant]);
    expect(result.kept).toEqual([]);
  });

  it("keeps every grant while the hub is merely unreachable", () => {
    expect(reconcileHeldGrants({ grants: [laptopGrant], held })).toEqual({
      kept: [laptopGrant],
      dropped: [],
    });
  });

  it("keeps a grant when a roster that is not newer omits its member", () => {
    const result = reconcileHeldGrants({
      grants: [laptopGrant],
      held,
      newer: roster(5, [member(1, "hub")]),
    });
    expect(result.dropped).toEqual([]);
  });

  it("keeps the grants of members a newer roster still lists", () => {
    const result = reconcileHeldGrants({
      grants: [laptopGrant],
      held,
      newer: roster(6, baseMembers),
    });
    expect(result.kept).toEqual([laptopGrant]);
  });
});

describe("admitNewMember", () => {
  const spokeId = memberId(3);
  const newGuest = member(4, "guest");
  const owner: HostOwnerEntry = {
    memberId: memberId(1),
    identityKeyFingerprint: key(1),
    unlockKeyFingerprint: key(8),
  };
  const confirmation: NewMemberConfirmation = {
    spokeId,
    memberId: newGuest.memberId,
    identityKeyFingerprint: newGuest.identityKeyFingerprint,
    confirmedBy: owner.memberId,
    unlockKeyFingerprint: owner.unlockKeyFingerprint,
    confirmedAt: "2026-10-28T10:00:00.000Z" as NewMemberConfirmation["confirmedAt"],
    signature: "c2ln" as NewMemberConfirmation["signature"],
  };
  const admit = (overrides: Partial<Parameters<typeof admitNewMember>[0]> = {}) =>
    admitNewMember({
      spokeId,
      member: newGuest,
      confirmNewMembers: false,
      owners: [owner],
      ...overrides,
    });

  it("admits a new member as a full member by default", () => {
    const result = admit();
    expect(result.status).toBe("full-member");
    expect(result.grant.delegation).toBeUndefined();
    expect(result.grant.answerApprovals).toBe(true);
    const spoke = admit({ member: member(5, "spoke") });
    expect(spoke.grant.delegation?.posture).toBe("approval-gated");
    expect(spoke.grant.delegation?.fullAccess).toBeUndefined();
  });

  it("holds a new member at status-only while Confirm new members is on and nothing confirms it", () => {
    expect(admit({ confirmNewMembers: true })).toEqual({
      status: "status-only",
      kind: "awaiting-confirmation",
      grant: { memberId: newGuest.memberId, readStatus: true },
    });
  });

  it("admits the member as a full member once an owner's verified confirmation names it", () => {
    const result = admit({
      confirmNewMembers: true,
      confirmation: { confirmation, signatureVerified: true },
    });
    expect(result.status).toBe("full-member");
  });

  it("keeps the member status-only when the confirmation is not valid for it", () => {
    const reasonFor = (
      confirmationValue: NewMemberConfirmation,
      signatureVerified = true,
      owners: ReadonlyArray<HostOwnerEntry> = [owner],
    ) => {
      const result = admit({
        confirmNewMembers: true,
        owners,
        confirmation: { confirmation: confirmationValue, signatureVerified },
      });
      return result.status === "status-only" ? result.reason : result.status;
    };
    expect(reasonFor({ ...confirmation, spokeId: memberId(5) })).toBe("wrong-spoke");
    expect(reasonFor({ ...confirmation, memberId: memberId(5) })).toBe("wrong-member");
    expect(reasonFor({ ...confirmation, identityKeyFingerprint: key(7) })).toBe("wrong-key");
    expect(reasonFor(confirmation, true, [])).toBe("not-an-owner");
    expect(reasonFor({ ...confirmation, unlockKeyFingerprint: key(7) })).toBe("not-an-owner");
    expect(reasonFor(confirmation, false)).toBe("signature-invalid");
  });
});

describe("honorOwner", () => {
  const owners: HostOwnerEntry[] = [
    { memberId: memberId(4), identityKeyFingerprint: key(4), unlockKeyFingerprint: key(8) },
  ];
  const marked = roster(5, [
    ...baseMembers.slice(0, 3),
    member(4, "guest", true),
    member(5, "guest", true),
  ]);

  it("honors a member on the host's own owner list", () => {
    const result = honorOwner({
      owners,
      roster: marked,
      memberId: memberId(4),
      identityKeyFingerprint: key(4),
    });
    expect(result.status).toBe("owner");
  });

  it("never makes an owner of a member that only the roster marks", () => {
    expect(
      honorOwner({ owners, roster: marked, memberId: memberId(5), identityKeyFingerprint: key(5) }),
    ).toEqual({ status: "not-owner", kind: "not-on-owner-list" });
  });

  it("refuses an owner that presents a different identity key", () => {
    expect(
      honorOwner({ owners, roster: marked, memberId: memberId(4), identityKeyFingerprint: key(7) }),
    ).toEqual({ status: "not-owner", kind: "identity-mismatch" });
  });

  it("ends owner powers once the roster no longer lists the member", () => {
    expect(
      honorOwner({
        owners,
        roster: roster(6, baseMembers.slice(0, 3)),
        memberId: memberId(4),
        identityKeyFingerprint: key(4),
      }),
    ).toEqual({ status: "not-owner", kind: "not-in-roster" });
  });
});

describe("authorizeOwnerRequest", () => {
  const owners: HostOwnerEntry[] = [
    { memberId: memberId(4), identityKeyFingerprint: key(4), unlockKeyFingerprint: key(8) },
  ];
  const held = roster(5, [...baseMembers, member(5, "spoke", true)]);
  const ask = (overrides: Partial<Parameters<typeof authorizeOwnerRequest>[0]> = {}) =>
    authorizeOwnerRequest({
      host: "spoke",
      grant: defaultHubGrant(),
      owners,
      roster: held,
      memberId: memberId(4),
      identityKeyFingerprint: key(4),
      unlock: "fresh",
      ...overrides,
    });

  it("allows a listed owner with a fresh unlock on a spoke that ticked Owners", () => {
    expect(ask().status).toBe("allowed");
  });

  it("refuses an owner without a fresh unlock", () => {
    expect(ask({ unlock: "absent" })).toEqual({ status: "refused", kind: "unlock-required" });
  });

  it("asks for no unlock when the request only reads or asks for a challenge", () => {
    expect(ask({ unlock: "not-needed" }).status).toBe("allowed");
    expect(
      ask({ unlock: "not-needed", memberId: memberId(5), identityKeyFingerprint: key(5) }),
    ).toEqual({ status: "refused", kind: "not-an-owner" });
  });

  it("refuses the hub and a standby even if an owner list names them", () => {
    const withHub: HostOwnerEntry[] = [
      ...owners,
      { memberId: memberId(1), identityKeyFingerprint: key(1), unlockKeyFingerprint: key(8) },
      { memberId: memberId(2), identityKeyFingerprint: key(2), unlockKeyFingerprint: key(8) },
    ];

    expect(ask({ owners: withHub, memberId: memberId(1), identityKeyFingerprint: key(1) })).toEqual(
      {
        status: "refused",
        kind: "hub-principal",
      },
    );
    expect(ask({ owners: withHub, memberId: memberId(2), identityKeyFingerprint: key(2) })).toEqual(
      {
        status: "refused",
        kind: "hub-principal",
      },
    );
  });

  it("refuses on a spoke whose hub grant leaves Owners unticked, but not on the hub", () => {
    const unticked = { items: ["roster"], actProjects: [] } as const;

    expect(ask({ grant: unticked })).toEqual({ status: "refused", kind: "owners-not-honored" });
    expect(ask({ grant: undefined })).toEqual({ status: "refused", kind: "owners-not-honored" });
    expect(ask({ host: "hub", grant: undefined }).status).toBe("allowed");
  });

  it("refuses a member that the roster marks as an owner but this host never listed", () => {
    expect(ask({ memberId: memberId(5), identityKeyFingerprint: key(5) })).toEqual({
      status: "refused",
      kind: "not-an-owner",
    });
  });

  it("refuses an owner that presents another identity key", () => {
    expect(ask({ identityKeyFingerprint: key(7) })).toEqual({
      status: "refused",
      kind: "identity-mismatch",
    });
  });
});

describe("the text an owner's unlock key signs", () => {
  const unlock = {
    challengeId: "c",
    nonce: "n",
    hostMemberId: "h",
    ownerMemberId: "o",
    method: "post",
    path: "/api/hub/owner/grant",
    bodyHash: key(1),
    expiresAt: 1,
  };

  it("binds the owner, the host, the method, the path, the body, and the expiry", () => {
    const base = ownerUnlockSigningPayload(unlock);

    expect(base).toBe(ownerUnlockSigningPayload({ ...unlock, method: "POST" }));
    for (const changed of [
      { challengeId: "x" },
      { nonce: "x" },
      { hostMemberId: "x" },
      { ownerMemberId: "x" },
      { method: "put" },
      { path: "/api/hub/owner/leave" },
      { bodyHash: key(2) },
      { expiresAt: 2 },
    ]) {
      expect(ownerUnlockSigningPayload({ ...unlock, ...changed })).not.toBe(base);
    }
  });

  it("names the spoke, the member, the key, and the owner a confirmation covers", () => {
    const confirmation = {
      spokeId: memberId(3),
      memberId: memberId(4),
      identityKeyFingerprint: key(4),
      confirmedBy: memberId(5),
      unlockKeyFingerprint: key(8),
      confirmedAt: "2026-10-29T10:00:00.000Z" as NewMemberConfirmation["confirmedAt"],
    };
    const base = newMemberConfirmationSigningPayload(confirmation);

    expect(
      newMemberConfirmationSigningPayload({ ...confirmation, memberId: memberId(6) }),
    ).not.toBe(base);
    expect(newMemberConfirmationSigningPayload({ ...confirmation, spokeId: memberId(6) })).not.toBe(
      base,
    );
  });

  it("keeps a challenge for under two minutes", () => {
    expect(OWNER_UNLOCK_LIFETIME_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("what the hub may use of a spoke's hub grant", () => {
  it("allows an item the spoke ticked and nothing else", () => {
    const grant = defaultHubGrant();

    expect(authorizeHubRequest({ grant, item: "roster" })).toEqual({ status: "allowed" });
    expect(authorizeHubRequest({ grant, item: "status" })).toEqual({
      status: "refused",
      kind: "item-not-granted",
    });
    expect(authorizeHubRequest({ grant, item: "act" })).toEqual({
      status: "refused",
      kind: "item-not-granted",
    });
  });

  it("refuses everything when the spoke holds no hub grant", () => {
    expect(authorizeHubRequest({ grant: undefined, item: "roster" })).toEqual({
      status: "refused",
      kind: "no-hub-grant",
    });
  });

  it("starts a new grant with the roster, Introduce, and Owners ticked and Projects unnamed", () => {
    expect(defaultHubGrant()).toEqual({
      items: ["roster", "introduce", "owners"],
      actProjects: [],
    });
  });
});

describe("the text a roster signature covers", () => {
  it("is the same whatever order a decoder produced the fields in", () => {
    const body = roster(3, baseMembers);
    const reordered: HubRoster = {
      failoverAfterSeconds: body.failoverAfterSeconds,
      standbyOrder: body.standbyOrder,
      members: body.members.map((entry) => ({
        owner: entry.owner,
        addresses: entry.addresses,
        privateNames: entry.privateNames,
        listenerPin: entry.listenerPin,
        identityKeyFingerprint: entry.identityKeyFingerprint,
        role: entry.role,
        name: entry.name,
        memberId: entry.memberId,
      })),
      sequence: body.sequence,
    };

    expect(hubRosterSigningPayload(reordered)).toBe(hubRosterSigningPayload(body));
  });

  it("changes when any member, role, or the sequence changes", () => {
    const body = roster(3, baseMembers);

    expect(hubRosterSigningPayload(roster(4, baseMembers))).not.toBe(hubRosterSigningPayload(body));
    expect(hubRosterSigningPayload(roster(3, baseMembers.slice(0, 3)))).not.toBe(
      hubRosterSigningPayload(body),
    );
    expect(
      hubRosterSigningPayload(roster(3, [...baseMembers.slice(0, 3), member(4, "spoke")])),
    ).not.toBe(hubRosterSigningPayload(body));
  });

  it("covers an owner's unlock key when a member carries one, and nothing extra when it does not", () => {
    const body = roster(3, baseMembers);
    const [first, ...rest] = baseMembers;
    if (first === undefined) throw new Error("No members.");
    const withKey = roster(3, [{ ...first, ownerUnlockPublicKey: "a_b-c" }, ...rest]);
    const otherKey = roster(3, [{ ...first, ownerUnlockPublicKey: "d_e-f" }, ...rest]);

    expect(hubRosterSigningPayload(withKey)).not.toBe(hubRosterSigningPayload(body));
    expect(hubRosterSigningPayload(withKey)).not.toBe(hubRosterSigningPayload(otherKey));
    expect(hubRosterSigningPayload(body)).not.toContain("ownerUnlockPublicKey");
  });
});

describe("the web app origin a roster entry gives a browser", () => {
  const named = (
    names: ReadonlyArray<string>,
    extra: Partial<RosterMember> = {},
  ): RosterMember => ({ ...member(3, "spoke"), privateNames: names, ...extra });

  it("names the Tailscale name and the listener port", () => {
    expect(rosterMemberWebOrigin(named(["Studio.tail1234.ts.net"], { listenerPort: 8443 }))).toBe(
      "https://studio.tail1234.ts.net:8443",
    );
    expect(rosterMemberWebOrigin(named(["studio.tail1234.ts.net"]))).toBe(
      "https://studio.tail1234.ts.net",
    );
  });

  it("names nothing for a member without a Tailscale name, or for a guest", () => {
    expect(rosterMemberWebOrigin(named([]))).toBeUndefined();
    expect(rosterMemberWebOrigin(named(["mac.local"]))).toBeUndefined();
    expect(rosterMemberWebOrigin(named(["evil.ts.net.example.com"]))).toBeUndefined();
    expect(
      rosterMemberWebOrigin(named(["phone.tail1234.ts.net"], { role: "guest" })),
    ).toBeUndefined();
  });
});
