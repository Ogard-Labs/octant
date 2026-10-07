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

/**
 * The key an instance's own first join request - its sequence 1 - names and is
 * signed with. Only the holder of that key can write it, so it is the one key
 * an approval of that instance may name.
 */
export interface ReplicaJoinRequestKey {
  readonly instanceId: ReplicaInstanceId;
  readonly publicKey: string;
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
 * a member and at or before every counted cut on that approver. An approval
 * counts only when the key it names is the key of the subject's own first join
 * request. Any member can sign an approval of any instance, so without this a
 * member could name its own key for another computer and then sign as it; the
 * join request is the one record only the real key holder can write. An
 * instance with no join request held, or with two naming different keys, is
 * admitted by nobody, and no approval picks a key by depth or approver id.
 * Every counted approval of one instance names the same key, so a later
 * approval never changes a member's key.
 *
 * Before revocations are weighed against each other, two kinds never count:
 * - one that cuts away its own revoker's admission, such as a revocation of
 *   the founder with a cut before the founder approved the revoker; and
 * - one that answers a revocation by an ancestor of its revoker - the
 *   computer that approved it, or that computer's approver, up to the root -
 *   by revoking that ancestor. Whoever brought a computer in can take it back
 *   out, and the computer it removed cannot remove it in return.
 * A member's ancestors are the ones every approval of it with the right key
 * shares, whatever round or cut it falls in, so a second approval of a
 * computer - by anyone, even one signed past its writer's cut - can narrow its
 * ancestry but never make its writer an ancestor. Narrowing also costs the
 * real approver its standing: two computers that then revoke each other both
 * stay revoked.
 *
 * The rest can still cut each other's revokers, so this is a fixed point: the
 * set that is certainly valid grows from nothing, and every revocation that
 * set leaves possible is honoured. Two computers that revoked each other,
 * neither an ancestor of the other, both stay revoked - when it is unclear,
 * the answer is the narrower membership.
 */
export function deriveReplicaMembership(input: {
  readonly roots: ReadonlyArray<ReplicaMembershipMember>;
  readonly requests: ReadonlyArray<ReplicaJoinRequestKey>;
  readonly admissions: ReadonlyArray<ReplicaAdmissionRecord>;
  readonly revocations: ReadonlyArray<ReplicaRevocationRecord>;
}): ReplicaDerivedMembership {
  const requested = requestedKeys(input.requests);
  const admissions = input.admissions.filter(
    (admission) =>
      requested.get(String(admission.member.instanceId)) === admission.member.publicKey,
  );
  const admitted = (counted: ReadonlyArray<ReplicaRevocationRecord>) =>
    admit(input.roots, admissions, counted).members;
  const standing = input.revocations.filter((revocation) =>
    signedWithin(
      admitted([revocation]),
      [revocation],
      revocation.revoker,
      revocation.revokerSequence,
    ),
  );
  const ancestors = ancestry(input.roots, admissions);
  const candidates = standing.filter(
    (revocation) =>
      !standing.some(
        (answer) =>
          same(answer.revoker, revocation.cut.instanceId) &&
          same(answer.cut.instanceId, revocation.revoker) &&
          (ancestors.get(String(revocation.revoker))?.has(String(answer.revoker)) ?? false),
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
 * Each instance's join-request key. Two requests of one instance naming
 * different keys leave it with none: its sequence 1 is written once, so two
 * keys mean one was forged, and neither is trusted.
 */
function requestedKeys(
  requests: ReadonlyArray<ReplicaJoinRequestKey>,
): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const request of requests) {
    const id = String(request.instanceId);
    const known = keys.get(id);
    if (known !== undefined && known !== request.publicKey) conflicted.add(id);
    keys.set(id, request.publicKey);
  }
  for (const id of conflicted) keys.delete(id);
  return keys;
}

/**
 * Admit in rounds outward from the roots. A member's record comes from its
 * first qualifying approval by approver id and sequence - every one names the
 * same key - so the result is the same in any input order. The ancestors it
 * returns weigh only the admitting round; `ancestry` narrows them further.
 */
function admit(
  roots: ReadonlyArray<ReplicaMembershipMember>,
  admissions: ReadonlyArray<ReplicaAdmissionRecord>,
  counted: ReadonlyArray<ReplicaRevocationRecord>,
): {
  readonly members: ReadonlyMap<string, ReplicaMembershipMember>;
  /** Each member's approvers up to a root; a root has none. */
  readonly ancestors: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const members = new Map(roots.map((root) => [String(root.instanceId), root] as const));
  const ancestors = new Map<string, ReadonlySet<string>>(
    roots.map((root) => [String(root.instanceId), new Set<string>()] as const),
  );
  for (;;) {
    const qualifying = new Map<string, ReplicaAdmissionRecord[]>();
    for (const admission of admissions) {
      const id = String(admission.member.instanceId);
      if (members.has(id)) continue;
      if (!signedWithin(members, counted, admission.approver, admission.approverSequence)) {
        continue;
      }
      qualifying.set(id, [...(qualifying.get(id) ?? []), admission]);
    }
    if (qualifying.size === 0) return { members, ancestors };
    for (const [id, approvals] of qualifying) {
      const [first, ...rest] = [...approvals].sort(byApprover);
      if (first === undefined) continue;
      members.set(id, first.member);
      let shared = lineage(ancestors, first.approver);
      for (const approval of rest) {
        const other = lineage(ancestors, approval.approver);
        shared = new Set([...shared].filter((ancestor) => other.has(ancestor)));
      }
      ancestors.set(id, shared);
    }
  }
}

/**
 * Each member's ancestors: the ones every counted approval of it shares, in
 * every round, not only the round that first admitted it. A computer nearer
 * the founder can approve a deeper one again with its real key and so admit it
 * a round earlier; weighing only that round would make the writer the deep
 * computer's sole line to the founder.
 *
 * Cuts are ignored here, deliberately: every approval only narrows the set,
 * so one signed past its writer's cut - which never admits anyone - cannot
 * make its writer an ancestor either. Dropping such an approval would instead
 * widen the set and let whoever placed a cut choose a computer's ancestors.
 *
 * The rounds give an upper bound; each pass intersects every approval again,
 * so the sets only shrink and the passes end.
 */
function ancestry(
  roots: ReadonlyArray<ReplicaMembershipMember>,
  admissions: ReadonlyArray<ReplicaAdmissionRecord>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const { members, ancestors: rounds } = admit(roots, admissions, []);
  const ancestors = new Map(rounds);
  for (let changed = true; changed;) {
    changed = false;
    for (const admission of admissions) {
      const id = String(admission.member.instanceId);
      const current = ancestors.get(id);
      if (current === undefined || !members.has(String(admission.approver))) continue;
      const line = lineage(ancestors, admission.approver);
      const shared = new Set([...current].filter((ancestor) => line.has(ancestor)));
      if (shared.size === current.size) continue;
      ancestors.set(id, shared);
      changed = true;
    }
  }
  return ancestors;
}

/** An approver and everyone above it. */
function lineage(
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  approver: ReplicaInstanceId,
): ReadonlySet<string> {
  return new Set([String(approver), ...(ancestors.get(String(approver)) ?? [])]);
}

function byApprover(left: ReplicaAdmissionRecord, right: ReplicaAdmissionRecord): number {
  const leftApprover = String(left.approver);
  const rightApprover = String(right.approver);
  if (leftApprover !== rightApprover) return leftApprover < rightApprover ? -1 : 1;
  return left.approverSequence - right.approverSequence;
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
