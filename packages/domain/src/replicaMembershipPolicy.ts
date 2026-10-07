/**
 * Who may write to a replica store.
 *
 * Membership is the authority half of artifact sync: entries are signed by a
 * device key, and only a member's key is accepted after a pull. This module
 * decides membership transitions from facts the host already holds. It does
 * not touch a keychain, a store, or the network, and it never sees private
 * key material - only public keys, fingerprints, and the records a store
 * already returned.
 *
 * There is no secret in a join. The joining computer publishes its public key
 * and name; the approving computer shows a matching code derived from the
 * join-request facts. Both people compare screens, and only then does the
 * member write the approval that makes the joiner a member.
 */

import type { ReplicaInstanceId } from "@octant/contracts/replica-entry";

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

export interface ReplicaMembershipMember {
  readonly instanceId: ReplicaInstanceId;
  readonly displayName: string;
  /** Base64-encoded SPKI of the device signing key this member writes with. */
  readonly publicKey: string;
}

/**
 * A revocation the host applied. It is a cut: the revoked instance's entries
 * at or before `lastAcceptedSequence` keep counting, and every later one is
 * refused.
 */
export interface ReplicaRevocationCut {
  readonly instanceId: ReplicaInstanceId;
  readonly lastAcceptedSequence: number;
}

export interface ReplicaMembershipFacts {
  readonly localInstanceId: ReplicaInstanceId;
  readonly members: ReadonlyArray<ReplicaMembershipMember>;
  /** Revocations the host has applied. */
  readonly revocations: ReadonlyArray<ReplicaRevocationCut>;
}

export interface ReplicaJoinRequestFacts {
  readonly origin: { readonly instanceId: ReplicaInstanceId; readonly displayName: string };
  readonly subject: ReplicaInstanceId;
  /** Base64-encoded SPKI public key the joining computer writes entries with. */
  readonly publicKey: string;
}

export type ReplicaApprovalRefusalReason = "already-member" | "revoked-instance";

export type ReplicaApprovalResult =
  | { readonly status: "approved" }
  | { readonly status: "refused"; readonly reason: ReplicaApprovalRefusalReason };

export type ReplicaRevocationRefusalReason =
  | "unknown-instance"
  | "not-a-member"
  | "revoked-instance";

export type ReplicaRevocationResult =
  | { readonly status: "revoked" }
  | { readonly status: "refused"; readonly reason: ReplicaRevocationRefusalReason };

/**
 * The bytes a matching code is derived from: the join request, the approver
 * with the device key it signs with, and the founder of the replica the
 * approver belongs to. Both computers build it on their own - the approver
 * from what it holds, the joining computer from the chain of signed approvals
 * it reads from the store - so a chain that names a different key for the
 * approver, or starts at a different founder, gives a different code.
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
 * Whether a join request may still be offered for approval. The joining
 * computer already wrote its request; a stale one is not offered again.
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
 * Decide whether this host may approve a join request it can see in the store.
 *
 * A member approves. The joining instance must not already be a member, and a
 * revoked identity cannot rejoin under the same instance id: re-joining is a
 * new identity, not the old one back.
 */
export function decideReplicaJoinApproval(input: {
  readonly facts: ReplicaMembershipFacts;
  readonly joinRequest: ReplicaJoinRequestFacts;
}): ReplicaApprovalResult {
  if (isRevoked(input.facts, input.joinRequest.subject)) {
    return { status: "refused", reason: "revoked-instance" };
  }
  if (isMember(input.facts, input.joinRequest.subject)) {
    return { status: "refused", reason: "already-member" };
  }
  return { status: "approved" };
}

/**
 * Whether revoking an instance is a coherent act right now. An unknown id has
 * no membership to remove; a non-member with a join request is not a member
 * yet; a revoked instance stays revoked.
 */
export function decideReplicaRevocation(
  facts: ReplicaMembershipFacts,
  subject: ReplicaInstanceId,
): ReplicaRevocationResult {
  if (isRevoked(facts, subject)) return { status: "refused", reason: "revoked-instance" };
  if (isMember(facts, subject)) return { status: "revoked" };
  return {
    status: "refused",
    reason: hasMembershipRecord(facts, subject) ? "not-a-member" : "unknown-instance",
  };
}

/** The earliest cut any applied revocation names for an instance. */
export function revocationCut(
  facts: Pick<ReplicaMembershipFacts, "revocations">,
  instanceId: ReplicaInstanceId,
): number | undefined {
  let cut: number | undefined;
  for (const revocation of facts.revocations) {
    if (String(revocation.instanceId) !== String(instanceId)) continue;
    cut =
      cut === undefined
        ? revocation.lastAcceptedSequence
        : Math.min(cut, revocation.lastAcceptedSequence);
  }
  return cut;
}

/** One approval a host holds: who admitted whom, at which of the approver's sequences. */
export interface ReplicaAdmissionRecord {
  readonly approver: ReplicaInstanceId;
  readonly approverSequence: number;
  readonly member: ReplicaMembershipMember;
}

/** One revocation a host holds: a cut on its subject, signed by the revoker at its sequence. */
export interface ReplicaRevocationRecord {
  readonly revoker: ReplicaInstanceId;
  readonly revokerSequence: number;
  readonly cut: ReplicaRevocationCut;
}

export interface ReplicaDerivedMembership {
  /** Everyone admitted, revoked members included: their entries up to a cut still count. */
  readonly members: ReadonlyArray<ReplicaMembershipMember>;
  /** The revocations that count. */
  readonly cuts: ReadonlyArray<ReplicaRevocationCut>;
}

/**
 * Members and revocations from every approval and revocation a host holds,
 * decided the same way whatever order they arrived in.
 *
 * A member is a root, or is admitted by an approval its approver signed while
 * a member and at or before every counted cut on that approver. When two
 * approvals admit the same instance with different keys, the one nearer a
 * root wins, then the lower approver id and sequence, so the key does not
 * depend on which record arrived first.
 *
 * Before revocations are weighed against each other, two kinds never count:
 * - one that cuts away its own revoker's admission, such as a revocation of
 *   the founder with a cut before the founder approved the revoker; and
 * - one that answers a revocation by an ancestor of its revoker - the
 *   computer that approved it, or that computer's approver, up to the root -
 *   by revoking that ancestor. Whoever brought a computer in can take it back
 *   out, and the computer it removed cannot remove it in return.
 * Ancestry follows the approval that admitted each member, ignoring cuts, so
 * an approval written later of a computer already in cannot make anyone its
 * ancestor.
 *
 * The rest can still cut each other's revokers, so this is a fixed point: the
 * set that is certainly valid grows from nothing, and every revocation that
 * set leaves possible is honoured. Two computers that revoked each other,
 * neither an ancestor of the other, both stay revoked - when it is unclear,
 * the answer is the narrower membership.
 */
export function deriveReplicaMembership(input: {
  readonly roots: ReadonlyArray<ReplicaMembershipMember>;
  readonly admissions: ReadonlyArray<ReplicaAdmissionRecord>;
  readonly revocations: ReadonlyArray<ReplicaRevocationRecord>;
}): ReplicaDerivedMembership {
  const admitted = (counted: ReadonlyArray<ReplicaRevocationRecord>) =>
    admit(input.roots, input.admissions, counted).members;
  const standing = input.revocations.filter((revocation) =>
    signedWithin(
      admitted([revocation]),
      [revocation],
      revocation.revoker,
      revocation.revokerSequence,
    ),
  );
  const { parents } = admit(input.roots, input.admissions, []);
  const candidates = standing.filter(
    (revocation) =>
      !standing.some(
        (answer) =>
          same(answer.revoker, revocation.cut.instanceId) &&
          same(answer.cut.instanceId, revocation.revoker) &&
          isAncestor(parents, answer.revoker, revocation.revoker),
      ),
  );
  const valid = (
    counted: ReadonlyArray<ReplicaRevocationRecord>,
  ): ReadonlyArray<ReplicaRevocationRecord> => {
    const members = admitted(counted);
    return candidates.filter((revocation) =>
      signedWithin(members, counted, revocation.revoker, revocation.revokerSequence),
    );
  };
  let certain: ReadonlyArray<ReplicaRevocationRecord> = [];
  for (let round = 0; round <= candidates.length + 1; round += 1) {
    const next = valid(valid(certain));
    if (next.length === certain.length) break;
    certain = next;
  }
  const honoured = valid(certain);
  return {
    members: [...admitted(honoured).values()],
    cuts: honoured.map((revocation) => revocation.cut),
  };
}

/**
 * Admit in rounds outward from the roots. Each round takes, per instance, the
 * first qualifying approval by approver id and sequence, so the result and
 * each member's key are the same in any input order.
 */
function admit(
  roots: ReadonlyArray<ReplicaMembershipMember>,
  admissions: ReadonlyArray<ReplicaAdmissionRecord>,
  counted: ReadonlyArray<ReplicaRevocationRecord>,
): {
  readonly members: ReadonlyMap<string, ReplicaMembershipMember>;
  readonly parents: ReadonlyMap<string, string>;
} {
  const members = new Map(roots.map((root) => [String(root.instanceId), root] as const));
  const parents = new Map<string, string>();
  for (;;) {
    const chosen = new Map<string, ReplicaAdmissionRecord>();
    for (const admission of admissions) {
      const id = String(admission.member.instanceId);
      if (members.has(id)) continue;
      if (!signedWithin(members, counted, admission.approver, admission.approverSequence)) {
        continue;
      }
      const best = chosen.get(id);
      if (best === undefined || precedes(admission, best)) chosen.set(id, admission);
    }
    if (chosen.size === 0) return { members, parents };
    for (const id of [...chosen.keys()].sort()) {
      const admission = chosen.get(id);
      if (admission === undefined) continue;
      members.set(id, admission.member);
      parents.set(id, String(admission.approver));
    }
  }
}

function precedes(left: ReplicaAdmissionRecord, right: ReplicaAdmissionRecord): boolean {
  const leftApprover = String(left.approver);
  const rightApprover = String(right.approver);
  if (leftApprover !== rightApprover) return leftApprover < rightApprover;
  return left.approverSequence < right.approverSequence;
}

/** Whether `ancestor` admitted `instanceId`, directly or through the approvals above it. */
function isAncestor(
  parents: ReadonlyMap<string, string>,
  ancestor: ReplicaInstanceId,
  instanceId: ReplicaInstanceId,
): boolean {
  let current = parents.get(String(instanceId));
  // Each parent was admitted in an earlier round, so the walk ends at a root.
  for (let steps = 0; current !== undefined && steps <= parents.size; steps += 1) {
    if (current === String(ancestor)) return true;
    current = parents.get(current);
  }
  return false;
}

/** Whether `instanceId` is a member and signed `sequence` at or before every counted cut on it. */
function signedWithin(
  members: ReadonlyMap<string, ReplicaMembershipMember>,
  counted: ReadonlyArray<ReplicaRevocationRecord>,
  instanceId: ReplicaInstanceId,
  sequence: number,
): boolean {
  if (!members.has(String(instanceId))) return false;
  return counted.every(
    (revocation) =>
      !same(revocation.cut.instanceId, instanceId) ||
      sequence <= revocation.cut.lastAcceptedSequence,
  );
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}

function isMember(facts: ReplicaMembershipFacts, instanceId: ReplicaInstanceId): boolean {
  return membershipRecord(facts, instanceId) !== undefined;
}

function isRevoked(facts: ReplicaMembershipFacts, instanceId: ReplicaInstanceId): boolean {
  return facts.revocations.some((revoked) => String(revoked.instanceId) === String(instanceId));
}

function hasMembershipRecord(
  facts: ReplicaMembershipFacts,
  instanceId: ReplicaInstanceId,
): boolean {
  return facts.members.some((member) => String(member.instanceId) === String(instanceId));
}

function membershipRecord(
  facts: ReplicaMembershipFacts,
  instanceId: ReplicaInstanceId,
): ReplicaMembershipMember | undefined {
  return facts.members.find((member) => String(member.instanceId) === String(instanceId));
}
