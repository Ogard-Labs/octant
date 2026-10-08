/**
 * Who may write to a replica store.
 *
 * Membership is the authority half of artifact sync. It is a pure function of
 * the founder a computer pinned and the set of membership records it holds.
 * Each record the host passes in is already valid on its own: its signature
 * checks against the key its own body names, and its instance id is that
 * key's id. Readers keep every valid record whoever wrote it and refuse
 * nothing on the way in; which records count is decided here, the same way
 * for any order, any duplicates, and any reader holding the same set.
 *
 * Who brought whom in is a two-party fact. A joiner signs a `join-accepted`
 * record naming the one approval it accepted, so each computer has exactly one
 * parent, and the parents form a tree no third party can change. Only a
 * strict ancestor in that tree may revoke a computer, and revocations are
 * weighed top-down from the founder in one pass: there is no fixed point and
 * no mutual revocation.
 *
 * This module never touches a keychain, a store, or the network, and it never
 * sees private key material.
 *
 * There is no secret in a join. The joining computer publishes its public key
 * and name; the approving computer shows a matching code derived from the
 * join-request facts. Both people compare screens, and only then does the
 * member write the approval and the joiner accept it.
 */

import type { ReplicaInstanceId, ReplicaMembershipEntry } from "@octant/contracts/replica-entry";

/** A join request older than this is not offered for approval. */
export const REPLICA_JOIN_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
/**
 * Few enough digits to read aloud, enough that two different requests rarely
 * share a code by chance. The code is a comparison, not a secret: it does not
 * hold against a party that can write the store and searches keys offline
 * for a colliding one. The signatures carry the authority.
 */
export const REPLICA_JOIN_MATCHING_CODE_DIGITS = 6;
/** The pairing comparison code derivation works over a fixed-width digest. */
export const REPLICA_JOIN_MATCHING_CODE_MODULUS = 1_000_000;

export interface ReplicaJoinRequestFacts {
  readonly origin: { readonly instanceId: ReplicaInstanceId; readonly displayName: string };
  readonly subject: ReplicaInstanceId;
  /** Base64-encoded SPKI public key the joining computer writes entries with. */
  readonly publicKey: string;
}

/**
 * The bytes a matching code is derived from: the join request, the approver
 * with the device key it signs with, and the founder of the replica the
 * approver belongs to. Both computers build it on their own - the approver
 * from what it holds, the joining computer from the parent edges it reads
 * from the store - so an approver key or founder that differs gives a
 * different code.
 */
export function buildReplicaJoinMatchingPreimage(input: {
  readonly joinRequest: ReplicaJoinRequestFacts;
  readonly approver: { readonly instanceId: ReplicaInstanceId; readonly publicKey: string };
  readonly founder: { readonly instanceId: ReplicaInstanceId; readonly publicKey: string };
}): string {
  return [
    "octant.replica-join.v2",
    String(input.joinRequest.origin.instanceId),
    input.joinRequest.origin.displayName,
    String(input.joinRequest.subject),
    input.joinRequest.publicKey,
    String(input.approver.instanceId),
    input.approver.publicKey,
    String(input.founder.instanceId),
    input.founder.publicKey,
  ].join("\n");
}

/**
 * Whether a join request may still be offered for approval.
 *
 * The window runs one way: a request whose signed time is later than now has
 * not happened yet, and without the lower bound a far-future time would never
 * leave the window.
 */
export function replicaJoinRequestIsFresh(requestedAt: number, now: number): boolean {
  const age = now - requestedAt;
  return age >= 0 && age <= REPLICA_JOIN_REQUEST_TTL_MS;
}

/**
 * One valid membership record a computer holds, with the SHA-256 of its file
 * bytes. The hash tells two different records in one slot apart, and it is
 * what a `join-accepted` record names its approval by.
 */
export interface ReplicaHeldRecord {
  readonly entry: ReplicaMembershipEntry;
  readonly hash: string;
}

/** One computer in the parent tree. */
export interface ReplicaMembershipNode {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: string;
  /** Base64-encoded SPKI of the device key this computer signs with. */
  readonly publicKey: string;
  /** The computer whose approval it accepted; the founder has none. */
  readonly parent: ReplicaInstanceId | undefined;
  /** The parent's sequence that approval sits at. */
  readonly approvalSequence: number | undefined;
  /** Whether its approval counts all the way up to the founder. */
  readonly admitted: boolean;
  /**
   * The last of its sequences that counts, when a revocation or a second
   * record in one of its slots set one. Undefined means every entry counts.
   */
  readonly cut: number | undefined;
}

export interface ReplicaDerivedMembership {
  readonly founder: ReplicaInstanceId | undefined;
  /**
   * Every computer reachable from the founder along parent edges, in
   * breadth-first order. A computer that is not admitted is in the tree but is
   * not a member, and neither is anything below it.
   */
  readonly nodes: ReadonlyArray<ReplicaMembershipNode>;
}

type JoinAccepted = Extract<ReplicaMembershipEntry, { kind: "join-accepted" }>;
type Revocation = Extract<ReplicaMembershipEntry, { kind: "revocation" }>;
type Founded = Extract<ReplicaMembershipEntry, { kind: "replica-founded" }>;

interface HeldFacts {
  /** Per instance, the lowest sequence holding two different records. */
  readonly equivocation: ReadonlyMap<string, number>;
  readonly live: ReadonlyArray<ReplicaMembershipEntry>;
  /** Live founding records by instance. */
  readonly founded: ReadonlyMap<string, Founded>;
  /** Each instance's own lowest live `join-accepted`, when the approval it names is held. */
  readonly edges: ReadonlyMap<string, JoinAccepted>;
}

/**
 * The facts every derivation shares: the equivocation cap, the records it
 * leaves live, and the parent edges. Records only; no cuts.
 *
 * Two different records in one slot can only both be signed by the key
 * holder, so a second one is evidence the key was stolen, and the instance is
 * capped just before that slot.
 */
function heldFacts(records: ReadonlyArray<ReplicaHeldRecord>): HeldFacts {
  const bySlot = new Map<string, Map<string, ReplicaMembershipEntry>>();
  for (const { entry, hash } of records) {
    const slot = slotKey(entry.origin.instanceId, entry.origin.sequence);
    const held = bySlot.get(slot) ?? new Map<string, ReplicaMembershipEntry>();
    held.set(hash, entry);
    bySlot.set(slot, held);
  }
  const equivocation = new Map<string, number>();
  for (const held of bySlot.values()) {
    const [first] = held.values();
    if (held.size < 2 || first === undefined) continue;
    const id = String(first.origin.instanceId);
    equivocation.set(id, Math.min(equivocation.get(id) ?? Infinity, first.origin.sequence));
  }
  const live: ReplicaMembershipEntry[] = [];
  const liveByHash = new Map<string, ReplicaMembershipEntry>();
  for (const [slot, held] of bySlot) {
    for (const [hash, entry] of held) {
      const cap = equivocation.get(String(entry.origin.instanceId)) ?? Infinity;
      if (entry.origin.sequence >= cap) continue;
      live.push(entry);
      liveByHash.set(`${slot}#${hash}`, entry);
    }
  }
  const founded = new Map<string, Founded>();
  const firstAccept = new Map<string, JoinAccepted>();
  for (const entry of live) {
    const id = String(entry.origin.instanceId);
    if (entry.kind === "replica-founded") founded.set(id, entry);
    if (entry.kind !== "join-accepted") continue;
    const known = firstAccept.get(id);
    if (known === undefined || entry.origin.sequence < known.origin.sequence) {
      firstAccept.set(id, entry);
    }
  }
  const edges = new Map<string, JoinAccepted>();
  for (const [child, accept] of firstAccept) {
    const approval = liveByHash.get(
      `${slotKey(accept.approver, accept.approvalSequence)}#${accept.approvalHash}`,
    );
    if (approval?.kind === "join-approved" && String(approval.subject) === child) {
      edges.set(child, accept);
    }
  }
  return { equivocation, live, founded, edges };
}

/**
 * Members, keys, the parent tree, and cuts, from the pinned founder and the
 * set of valid records a computer holds.
 *
 * A computer's parent comes from its own lowest-sequence `join-accepted`
 * record, and only when the approval it names - by writer, sequence, and hash -
 * is held and approves that computer. Nobody becomes a computer's ancestor
 * without that computer accepting them and them approving it.
 *
 * Standing is weighed top-down from the founder. A computer is admitted when
 * its parent is admitted and signed the approval at or before the parent's
 * cut. Its cut is the lowest cut named by a revocation that a strict ancestor
 * signed while admitted and at or before its own cut, or just before a slot
 * it signed two different records into. Everything a computer's cut depends
 * on is above it in the tree and already decided, so there is no iteration
 * and no tie-break. Records this pass does not use - an approval the joiner
 * never accepted, a descendant's revocation of an ancestor, a ghost's
 * records - are inert.
 */
export function deriveReplicaMembership(
  founder: ReplicaInstanceId | undefined,
  records: ReadonlyArray<ReplicaHeldRecord>,
): ReplicaDerivedMembership {
  if (founder === undefined) return { founder, nodes: [] };
  const facts = heldFacts(records);
  const founderId = String(founder);
  const root = facts.founded.get(founderId);
  if (root === undefined) return { founder, nodes: [] };
  const children = new Map<string, JoinAccepted[]>();
  for (const [id, accept] of facts.edges) {
    if (id === founderId) continue;
    const parent = String(accept.approver);
    children.set(parent, [...(children.get(parent) ?? []), accept]);
  }
  const revocations = new Map<string, Revocation[]>();
  for (const entry of facts.live) {
    if (entry.kind !== "revocation") continue;
    const subject = String(entry.subject);
    revocations.set(subject, [...(revocations.get(subject) ?? []), entry]);
  }
  const capOf = (id: string) => (facts.equivocation.get(id) ?? Infinity) - 1;
  const standing = new Map<
    string,
    { readonly admitted: boolean; readonly cut: number; readonly ancestors: ReadonlySet<string> }
  >([[founderId, { admitted: true, cut: capOf(founderId), ancestors: new Set() }]]);
  const nodes: ReplicaMembershipNode[] = [
    {
      instanceId: root.origin.instanceId,
      displayName: root.origin.displayName,
      publicKey: root.origin.publicKey,
      parent: undefined,
      approvalSequence: undefined,
      admitted: true,
      cut: finite(capOf(founderId)),
    },
  ];
  for (let index = 0; index < nodes.length; index += 1) {
    const parentNode = nodes[index];
    if (parentNode === undefined) break;
    const parentId = String(parentNode.instanceId);
    const parent = standing.get(parentId);
    if (parent === undefined) continue;
    // Siblings sit at distinct sequences of their parent, so this order
    // depends only on the records, not on how ids happen to sort.
    const below = [...(children.get(parentId) ?? [])].sort(
      (left, right) => left.approvalSequence - right.approvalSequence,
    );
    for (const accept of below) {
      const id = String(accept.origin.instanceId);
      if (standing.has(id)) continue;
      const ancestors = new Set([parentId, ...parent.ancestors]);
      const admitted = parent.admitted && accept.approvalSequence <= parent.cut;
      let cut = capOf(id);
      for (const revocation of revocations.get(id) ?? []) {
        const revoker = String(revocation.origin.instanceId);
        if (!ancestors.has(revoker)) continue;
        const by = standing.get(revoker);
        if (by === undefined || !by.admitted || revocation.origin.sequence > by.cut) continue;
        cut = Math.min(cut, revocation.cut);
      }
      standing.set(id, { admitted, cut, ancestors });
      nodes.push({
        instanceId: accept.origin.instanceId,
        displayName: accept.origin.displayName,
        publicKey: accept.origin.publicKey,
        parent: parentNode.instanceId,
        approvalSequence: accept.approvalSequence,
        admitted,
        cut: finite(cut),
      });
    }
  }
  return { founder, nodes };
}

/**
 * The founding record that the parent edges reach from `approver`, walking up
 * one accepted approval at a time. Each edge is a record the child signed, so
 * the walk is unique and reaches at most one founder; a cycle reaches none.
 */
export function replicaFounderReachedFrom(
  records: ReadonlyArray<ReplicaHeldRecord>,
  approver: ReplicaInstanceId,
): Founded | undefined {
  const facts = heldFacts(records);
  const seen = new Set<string>();
  for (let current: string | undefined = String(approver); current !== undefined;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const founded = facts.founded.get(current);
    if (founded !== undefined) return founded;
    const edge = facts.edges.get(current);
    current = edge === undefined ? undefined : String(edge.approver);
  }
  return undefined;
}

/**
 * The approval of `subject` by `approver` that a joiner may accept: the
 * lowest-sequence live one, with the hash its accept must name.
 */
export function replicaApprovalOf(
  records: ReadonlyArray<ReplicaHeldRecord>,
  approver: ReplicaInstanceId,
  subject: ReplicaInstanceId,
): ReplicaHeldRecord | undefined {
  const cap = heldFacts(records).equivocation.get(String(approver)) ?? Infinity;
  let found: ReplicaHeldRecord | undefined;
  for (const record of records) {
    const { entry } = record;
    if (
      entry.kind !== "join-approved" ||
      !same(entry.origin.instanceId, approver) ||
      !same(entry.subject, subject) ||
      entry.origin.sequence >= cap
    ) {
      continue;
    }
    if (found === undefined || entry.origin.sequence < found.entry.origin.sequence) found = record;
  }
  return found;
}

export function replicaMembershipNode(
  membership: ReplicaDerivedMembership,
  instanceId: ReplicaInstanceId,
): ReplicaMembershipNode | undefined {
  return membership.nodes.find((node) => same(node.instanceId, instanceId));
}

/** Admitted computers, revoked ones included: their entries up to a cut still count. */
export function replicaMembers(
  membership: ReplicaDerivedMembership,
): ReadonlyArray<ReplicaMembershipNode> {
  return membership.nodes.filter((node) => node.admitted);
}

/** Whether the entry `instanceId` signed at `sequence` counts. */
export function replicaEntryCounts(
  membership: ReplicaDerivedMembership,
  instanceId: ReplicaInstanceId,
  sequence: number,
): boolean {
  const node = replicaMembershipNode(membership, instanceId);
  return node !== undefined && node.admitted && sequence <= (node.cut ?? Infinity);
}

/** Whether `ancestor` brought `instanceId` in, directly or through others. */
export function isReplicaAncestor(
  membership: ReplicaDerivedMembership,
  ancestor: ReplicaInstanceId,
  instanceId: ReplicaInstanceId,
): boolean {
  // The tree has no cycles: every node's parent was placed before it.
  let current = replicaMembershipNode(membership, instanceId)?.parent;
  while (current !== undefined) {
    if (same(current, ancestor)) return true;
    current = replicaMembershipNode(membership, current)?.parent;
  }
  return false;
}

/** Admitted computers that `instanceId` brought in, directly or through others. */
export function replicaDescendants(
  membership: ReplicaDerivedMembership,
  instanceId: ReplicaInstanceId,
): ReadonlyArray<ReplicaMembershipNode> {
  return membership.nodes.filter(
    (node) => node.admitted && isReplicaAncestor(membership, instanceId, node.instanceId),
  );
}

/** Admitted with no cut: the standing a computer needs to approve or revoke. */
export function replicaInGoodStanding(
  membership: ReplicaDerivedMembership,
  instanceId: ReplicaInstanceId,
): boolean {
  const node = replicaMembershipNode(membership, instanceId);
  return node !== undefined && node.admitted && node.cut === undefined;
}

export type ReplicaApprovalResult =
  | { readonly status: "approved" }
  | {
      readonly status: "refused";
      readonly reason: "not-a-member" | "already-member" | "revoked-instance";
    };

/**
 * Whether `local` may approve `subject`'s join request. The approver needs
 * good standing. A computer already in the tree is either a member or has
 * lost its place, and an identity has one parent forever: coming back is a
 * new identity, never another approval of the old one.
 */
export function decideReplicaJoinApproval(input: {
  readonly membership: ReplicaDerivedMembership;
  readonly local: ReplicaInstanceId;
  readonly subject: ReplicaInstanceId;
}): ReplicaApprovalResult {
  if (!replicaInGoodStanding(input.membership, input.local)) {
    return { status: "refused", reason: "not-a-member" };
  }
  const subject = replicaMembershipNode(input.membership, input.subject);
  if (subject === undefined) return { status: "approved" };
  return {
    status: "refused",
    reason: subject.admitted && subject.cut === undefined ? "already-member" : "revoked-instance",
  };
}

export type ReplicaRevocationResult =
  | { readonly status: "revoked" }
  | {
      readonly status: "refused";
      readonly reason:
        | "not-a-member"
        | "unknown-instance"
        | "not-a-descendant"
        | "revoked-instance";
    };

/**
 * Whether `local` may revoke `subject`. Only a strict ancestor may: whoever
 * brought a computer in can take it out, and that computer cannot remove it
 * in return. A sibling or cousin asks a shared ancestor, the founder at worst.
 */
export function decideReplicaRevocation(input: {
  readonly membership: ReplicaDerivedMembership;
  readonly local: ReplicaInstanceId;
  readonly subject: ReplicaInstanceId;
}): ReplicaRevocationResult {
  if (!replicaInGoodStanding(input.membership, input.local)) {
    return { status: "refused", reason: "not-a-member" };
  }
  const subject = replicaMembershipNode(input.membership, input.subject);
  if (subject === undefined || !subject.admitted) {
    return { status: "refused", reason: "unknown-instance" };
  }
  if (!isReplicaAncestor(input.membership, input.local, input.subject)) {
    return { status: "refused", reason: "not-a-descendant" };
  }
  if (subject.cut !== undefined) return { status: "refused", reason: "revoked-instance" };
  return { status: "revoked" };
}

function finite(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function slotKey(instanceId: ReplicaInstanceId, sequence: number): string {
  return `${String(instanceId)}/${String(sequence)}`;
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}
