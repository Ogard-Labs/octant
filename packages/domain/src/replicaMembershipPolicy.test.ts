import { describe, expect, it } from "vitest";
import {
  REPLICA_ENTRY_FORMAT,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
} from "@octant/contracts/replica-entry";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  deriveReplicaMembership,
  replicaApprovalOf,
  replicaDescendants,
  replicaEntryCounts,
  replicaFounderReachedFrom,
  replicaJoinRequestIsFresh,
  replicaMembershipNode,
  REPLICA_JOIN_REQUEST_TTL_MS,
  type ReplicaDerivedMembership,
  type ReplicaHeldRecord,
} from "./replicaMembershipPolicy";

const ids = {
  founder: "11111111-1111-8111-8111-111111111111" as ReplicaInstanceId,
  south: "22222222-2222-8222-8222-222222222222" as ReplicaInstanceId,
  east: "33333333-3333-8333-8333-333333333333" as ReplicaInstanceId,
  west: "44444444-4444-8444-8444-444444444444" as ReplicaInstanceId,
  ghost: "55555555-5555-8555-8555-555555555555" as ReplicaInstanceId,
  other: "66666666-6666-8666-8666-666666666666" as ReplicaInstanceId,
} as const;

const keyOf = (id: ReplicaInstanceId) => `key-${String(id).slice(0, 8)}`;
const origin = (id: ReplicaInstanceId, sequence: number) => ({
  instanceId: id,
  displayName: `Computer ${String(id).slice(0, 2)}`,
  sequence,
  publicKey: keyOf(id),
});
let hashes = 0;
function held(entry: ReplicaMembershipEntry): ReplicaHeldRecord {
  hashes += 1;
  return { entry, hash: String(hashes).padStart(64, "0") };
}

const founded = (id: ReplicaInstanceId) =>
  held({ format: REPLICA_ENTRY_FORMAT, kind: "replica-founded", origin: origin(id, 1) });
const approval = (by: ReplicaInstanceId, sequence: number, subject: ReplicaInstanceId) =>
  held({
    format: REPLICA_ENTRY_FORMAT,
    kind: "join-approved",
    origin: origin(by, sequence),
    subject,
    subjectKey: keyOf(subject),
    subjectName: "Joiner",
  });
function accept(
  child: ReplicaInstanceId,
  sequence: number,
  of: ReplicaHeldRecord,
  approvalHash = of.hash,
): ReplicaHeldRecord {
  return held({
    format: REPLICA_ENTRY_FORMAT,
    kind: "join-accepted",
    origin: origin(child, sequence),
    approver: of.entry.origin.instanceId,
    approvalSequence: of.entry.origin.sequence,
    approvalHash,
    founder: ids.founder,
  });
}
const revocation = (
  by: ReplicaInstanceId,
  sequence: number,
  subject: ReplicaInstanceId,
  cut: number,
) =>
  held({
    format: REPLICA_ENTRY_FORMAT,
    kind: "revocation",
    origin: origin(by, sequence),
    subject,
    cut,
  });

/** The founder approves South at 2 and East at 3; South approves West at 3. */
function tree() {
  const southApproval = approval(ids.founder, 2, ids.south);
  const eastApproval = approval(ids.founder, 3, ids.east);
  const westApproval = approval(ids.south, 3, ids.west);
  return {
    westApproval,
    records: [
      founded(ids.founder),
      southApproval,
      accept(ids.south, 2, southApproval),
      eastApproval,
      accept(ids.east, 2, eastApproval),
      westApproval,
      accept(ids.west, 2, westApproval),
    ],
  };
}

function standing(membership: ReplicaDerivedMembership, id: ReplicaInstanceId): string {
  const node = replicaMembershipNode(membership, id);
  if (node === undefined) return "absent";
  if (!node.admitted) return "not admitted";
  return node.cut === undefined ? "member" : `cut@${node.cut}`;
}

describe("replica membership policy", () => {
  it("derives the same matching preimage from the same join facts on both computers", () => {
    const joinRequest = {
      origin: { instanceId: ids.south, displayName: "Mac mini" },
      subject: ids.south,
      publicKey: "pub-mac-mini",
    };
    const approver = { instanceId: ids.east, publicKey: "pub-approver" };
    const founder = { instanceId: ids.founder, publicKey: "pub-macbook" };
    const first = buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder });
    expect(buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder })).toBe(first);
    expect(first).toContain("octant.replica-join.v2");
    // Another key for the approver, or another founder, describes a different join.
    expect(
      buildReplicaJoinMatchingPreimage({
        joinRequest,
        approver: { ...approver, publicKey: "pub-forged" },
        founder,
      }),
    ).not.toBe(first);
    expect(
      buildReplicaJoinMatchingPreimage({
        joinRequest,
        approver,
        founder: { instanceId: ids.other, publicKey: "pub-forged" },
      }),
    ).not.toBe(first);
  });

  it("does not offer a join request past its freshness window", () => {
    const requestedAt = 1_000;
    expect(replicaJoinRequestIsFresh(requestedAt, requestedAt + REPLICA_JOIN_REQUEST_TTL_MS)).toBe(
      true,
    );
    expect(
      replicaJoinRequestIsFresh(requestedAt, requestedAt + REPLICA_JOIN_REQUEST_TTL_MS + 1),
    ).toBe(false);
  });

  it("refuses a join request whose time has not happened yet", () => {
    const now = 1_000_000;
    expect(replicaJoinRequestIsFresh(now + 1, now)).toBe(false);
    expect(replicaJoinRequestIsFresh(now + REPLICA_JOIN_REQUEST_TTL_MS, now)).toBe(false);
    expect(replicaJoinRequestIsFresh(now - REPLICA_JOIN_REQUEST_TTL_MS, now)).toBe(true);
  });
});

describe("replica membership derivation", () => {
  it("admits each computer through the one approval it accepted, with that computer's key", () => {
    const membership = deriveReplicaMembership(ids.founder, tree().records);
    expect(membership.nodes.map((node) => [String(node.instanceId), String(node.parent)])).toEqual([
      [ids.founder, "undefined"],
      [ids.south, ids.founder],
      [ids.east, ids.founder],
      [ids.west, ids.south],
    ]);
    expect(replicaMembershipNode(membership, ids.west)?.publicKey).toBe(keyOf(ids.west));
  });

  it("admits nobody without the pinned founder's own record, or with no founder pinned", () => {
    const { records } = tree();
    expect(deriveReplicaMembership(ids.other, records).nodes).toEqual([]);
    expect(deriveReplicaMembership(undefined, records).nodes).toEqual([]);
  });

  it("does not admit a computer an approval names until that computer accepts it", () => {
    const records = [founded(ids.founder), approval(ids.founder, 2, ids.south)];
    expect(standing(deriveReplicaMembership(ids.founder, records), ids.south)).toBe("absent");
  });

  it("does not let another approval or a later accept change a computer's parent", () => {
    const { records, westApproval } = tree();
    // East approves West too, and someone holding West's key accepts it later:
    // the lowest accept still names South.
    const eastAgain = approval(ids.east, 3, ids.west);
    const membership = deriveReplicaMembership(ids.founder, [
      ...records,
      eastAgain,
      accept(ids.west, 3, eastAgain),
    ]);
    expect(String(replicaMembershipNode(membership, ids.west)?.parent)).toBe(ids.south);
    expect(replicaMembershipNode(membership, ids.west)?.approvalSequence).toBe(
      westApproval.entry.origin.sequence,
    );
  });

  it("does not admit through an accept whose approval hash names other bytes", () => {
    const southApproval = approval(ids.founder, 2, ids.south);
    const membership = deriveReplicaMembership(ids.founder, [
      founded(ids.founder),
      southApproval,
      accept(ids.south, 2, southApproval, "e".repeat(64)),
    ]);
    expect(standing(membership, ids.south)).toBe("absent");
  });

  it("lets only a strict ancestor revoke, so a computer cannot revoke the one that approved it", () => {
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      // West revokes its approver and the founder; East revokes its sibling.
      revocation(ids.west, 3, ids.south, 0),
      revocation(ids.west, 4, ids.founder, 0),
      revocation(ids.east, 3, ids.south, 0),
      // The founder revokes West through South.
      revocation(ids.founder, 4, ids.west, 2),
    ]);
    expect(standing(membership, ids.founder)).toBe("member");
    expect(standing(membership, ids.south)).toBe("member");
    expect(standing(membership, ids.east)).toBe("member");
    expect(standing(membership, ids.west)).toBe("cut@2");
  });

  it("takes the earliest cut when two ancestors revoke the same computer", () => {
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      revocation(ids.founder, 4, ids.west, 3),
      revocation(ids.south, 4, ids.west, 2),
    ]);
    expect(standing(membership, ids.west)).toBe("cut@2");
  });

  it("stops counting what a computer signed after its cut, approvals and revocations included", () => {
    const { records } = tree();
    const westBelow = approval(ids.west, 3, ids.other);
    const below = [westBelow, accept(ids.other, 2, westBelow)];
    // South is cut at 3, so its revocation of West at 5 no longer counts.
    const southCut = deriveReplicaMembership(ids.founder, [
      ...records,
      ...below,
      revocation(ids.south, 5, ids.west, 2),
      revocation(ids.founder, 4, ids.south, 3),
    ]);
    expect(standing(southCut, ids.south)).toBe("cut@3");
    expect(standing(southCut, ids.west)).toBe("member");
    // West cut at 2: its approval at 3 stops counting, and so does Other.
    const westCut = deriveReplicaMembership(ids.founder, [
      ...records,
      ...below,
      revocation(ids.founder, 4, ids.west, 2),
    ]);
    expect(standing(westCut, ids.other)).toBe("not admitted");
    expect(replicaEntryCounts(westCut, ids.west, 2)).toBe(true);
    expect(replicaEntryCounts(westCut, ids.west, 3)).toBe(false);
    expect(replicaEntryCounts(westCut, ids.other, 1)).toBe(false);
  });

  it("caps a computer just before a slot it signed two different records into", () => {
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      revocation(ids.south, 4, ids.west, 2),
      approval(ids.south, 4, ids.other),
    ]);
    expect(standing(membership, ids.south)).toBe("cut@3");
    // Neither record in the slot counts, so West keeps its standing.
    expect(standing(membership, ids.west)).toBe("member");
  });

  it("places nobody through two different accepts a joiner signed into one slot, whatever order they arrive in", () => {
    const { records } = tree();
    const southOther = approval(ids.south, 4, ids.other);
    const eastOther = approval(ids.east, 3, ids.other);
    const accepts = [accept(ids.other, 2, southOther), accept(ids.other, 2, eastOther)];
    for (const ordered of [accepts, [...accepts].reverse()]) {
      const membership = deriveReplicaMembership(ids.founder, [
        ...records,
        southOther,
        eastOther,
        ...ordered,
      ]);
      // Either accept alone would give Other a parent; holding both is the
      // key holder's own equivocation, so neither edge exists.
      expect(standing(membership, ids.other)).toBe("absent");
    }
  });

  it("ignores a ghost's approval of a real member, and its revocations", () => {
    const ghostApproval = approval(ids.east, 4, ids.ghost);
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      ghostApproval,
      accept(ids.ghost, 2, ghostApproval),
      approval(ids.ghost, 3, ids.west),
      revocation(ids.ghost, 4, ids.south, 0),
      revocation(ids.ghost, 5, ids.west, 0),
    ]);
    expect(standing(membership, ids.ghost)).toBe("member");
    expect(standing(membership, ids.south)).toBe("member");
    expect(standing(membership, ids.west)).toBe("member");
    expect(String(replicaMembershipNode(membership, ids.west)?.parent)).toBe(ids.south);
  });

  it("derives the same members and cuts for every order and duplicate of the same records", () => {
    const all = [
      ...tree().records,
      revocation(ids.founder, 4, ids.west, 2),
      revocation(ids.west, 3, ids.south, 0),
    ];
    const expected = deriveReplicaMembership(ids.founder, all);
    for (let shift = 0; shift < all.length; shift += 1) {
      const rotated = [...all.slice(shift), ...all.slice(0, shift)].reverse();
      const again = deriveReplicaMembership(ids.founder, [...rotated, ...rotated.slice(0, shift)]);
      expect(again).toEqual(expected);
    }
  });

  it("walks parent edges up from an approver to exactly one founder", () => {
    const { records, westApproval } = tree();
    expect(replicaFounderReachedFrom(records, ids.west)?.origin.instanceId).toBe(ids.founder);
    expect(replicaFounderReachedFrom(records, ids.ghost)).toBeUndefined();
    expect(replicaApprovalOf(records, ids.south, ids.west)).toEqual(westApproval);
    // A second founding record elsewhere does not reach a member whose edges lead home.
    expect(
      replicaFounderReachedFrom([...records, founded(ids.other)], ids.west)?.origin.instanceId,
    ).toBe(ids.founder);
  });
});

describe("replica membership decisions", () => {
  it("lets a member in good standing approve a computer that is not in the tree", () => {
    const membership = deriveReplicaMembership(ids.founder, tree().records);
    expect(decideReplicaJoinApproval({ membership, local: ids.south, subject: ids.other })).toEqual(
      { status: "approved" },
    );
    expect(decideReplicaJoinApproval({ membership, local: ids.south, subject: ids.east })).toEqual({
      status: "refused",
      reason: "already-member",
    });
    expect(decideReplicaJoinApproval({ membership, local: ids.other, subject: ids.ghost })).toEqual(
      { status: "refused", reason: "not-a-member" },
    );
  });

  it("refuses to approve a revoked identity again", () => {
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      revocation(ids.founder, 4, ids.east, 2),
    ]);
    expect(
      decideReplicaJoinApproval({ membership, local: ids.founder, subject: ids.east }),
    ).toEqual({ status: "refused", reason: "revoked-instance" });
  });

  it("lets a computer revoke only the computers it brought in", () => {
    const membership = deriveReplicaMembership(ids.founder, tree().records);
    expect(decideReplicaRevocation({ membership, local: ids.south, subject: ids.west })).toEqual({
      status: "revoked",
    });
    expect(decideReplicaRevocation({ membership, local: ids.east, subject: ids.west })).toEqual({
      status: "refused",
      reason: "not-a-descendant",
    });
    expect(decideReplicaRevocation({ membership, local: ids.west, subject: ids.south })).toEqual({
      status: "refused",
      reason: "not-a-descendant",
    });
    expect(decideReplicaRevocation({ membership, local: ids.founder, subject: ids.other })).toEqual(
      { status: "refused", reason: "unknown-instance" },
    );
    expect(replicaDescendants(membership, ids.founder).map((node) => node.instanceId)).toEqual([
      ids.south,
      ids.east,
      ids.west,
    ]);
  });

  it("keeps an ancestor able to revoke after a descendant revoked it", () => {
    const membership = deriveReplicaMembership(ids.founder, [
      ...tree().records,
      revocation(ids.west, 3, ids.south, 0),
    ]);
    expect(decideReplicaRevocation({ membership, local: ids.south, subject: ids.west })).toEqual({
      status: "revoked",
    });
  });
});
