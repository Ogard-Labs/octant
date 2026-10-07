/**
 * Commands a host person runs to manage who may write to a replica store, and
 * the read path that decides which store entries this host accepts.
 *
 * The service composes the pure membership and reconcile policies, the device
 * signing key, the write-once store, and the journal. Every outcome -
 * including refusals and store failures - is journaled, because "why is that
 * computer not a member" has to stay answerable after the fact. Facts come
 * only from the journal's membership projection, so a restart decides the same
 * way. A store failure never unwinds a local decision, and no secret ever
 * passes through the store: only public keys, names, and signed records.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  REPLICA_ENTRY_FORMAT,
  ReplicaInstanceId,
  decodeReplicaEntryText,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  replicaEntryContentPreimage,
  replicaEntryRelativePaths,
  type HostId,
  type ReplicaEntry,
  type ReplicaMembershipEntry,
  type ReplicaMembershipCommand,
  type ReplicaMembershipResult,
  type ReplicaReadRefusal,
  type ReplicaReadRefusalReason,
  type ReplicaSignatureVerdict,
} from "@octant/contracts";
import {
  REPLICA_REFUSAL_REASONS,
  reconcileReplicaEntry,
  type ReplicaLocalState,
} from "@octant/domain/replica-entry-policy";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  replicaJoinRequestIsFresh,
  replicaMembershipAcceptsKey,
  type ReplicaJoinRequestFacts,
  type ReplicaMembershipFacts,
} from "@octant/domain/replica-membership-policy";
import type { ReplicaStore } from "@octant/plugin-api/replica-store";
import { Schema } from "effect";
import {
  verifyReplicaEntrySignature,
  type ReplicaDeviceSigningKey,
} from "./replicaDeviceKeyService";
import {
  REPLICA_MEMBERSHIP_EVENT_NAMES,
  type ReplicaLocalIdentity,
  type ReplicaMembershipJournal,
  type ReplicaMembershipState,
} from "./replicaMembershipProjection";

// Every reason the reconcile policy can return is one the read path reports.
const reconcileReasonsAreReadReasons: ReadonlyArray<ReplicaReadRefusalReason> =
  REPLICA_REFUSAL_REASONS;
void reconcileReasonsAreReadReasons;

/** Which store this host writes and reads, if any. */
export type ReplicaStoreSelection =
  | { readonly status: "not-configured" }
  | { readonly status: "selected"; readonly store: ReplicaStore };

export interface ReplicaMembershipPorts {
  /** The store this host is set up with. Asked once per command. */
  readonly store: () => ReplicaStoreSelection;
  /** Host credential store holding each instance's device signing key. */
  readonly credentials: {
    readonly ensure: (instanceId: string) => Promise<ReplicaDeviceSigningKey>;
    readonly sign: (
      instanceId: string,
      payload: Uint8Array,
    ) => Promise<{ readonly signature: string }>;
  };
  readonly journal: ReplicaMembershipJournal;
  /** Membership facts, rebuilt from the journal. */
  readonly state: () => ReplicaMembershipState;
  readonly localHostId: HostId;
  readonly clock: () => number;
  readonly newInstanceId?: () => ReplicaInstanceId;
}

export type ReplicaMembershipOutcome = ReplicaMembershipResult;
type RefusalReason = Extract<ReplicaMembershipOutcome, { kind: "refused" }>["reason"];

/** Bounds one pull so a hostile listing cannot keep the host walking forever. */
const MAX_LIST_PAGES = 1_000;
const MAX_ENTRIES_PER_INSTANCE = 100_000;
const ENTRY_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([1-9][0-9]{0,15})\.(json|sig)$/;
const decodeInstanceId = Schema.decodeUnknownSync(ReplicaInstanceId);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The six-digit code a person compares between the joining computer and the
 * approving one.
 *
 * It is a SHA-256 digest, reduced to six digits, of the joiner's instance id,
 * name, and device public key, and the approver's instance id. Equal codes mean
 * both screens describe the same join request and the same approver, so a
 * person notices a request from a different computer - or an approval by a
 * different member - before it takes effect. It is not a secret and proves
 * nothing by itself: anyone who can read the store can compute it, and six
 * digits leave room for a party that can also write the store to search keys
 * offline until one collides. What makes the approval authoritative is the
 * joiner's signature on the stored request and the approver's signature on the
 * approval; the code only binds a person's comparison to those two records.
 */
export function deriveReplicaJoinMatchingCode(input: {
  readonly joinRequest: ReplicaMembershipEntry;
  readonly approverInstanceId: ReplicaInstanceId;
}): string {
  const deviceKey = input.joinRequest.subjectDeviceKey;
  if (deviceKey === undefined) {
    throw new Error("A join request without a device key has no matching code.");
  }
  return matchingCode(
    {
      origin: {
        instanceId: input.joinRequest.origin.instanceId,
        displayName: input.joinRequest.origin.displayName,
      },
      subject: input.joinRequest.subject,
      publicKey: deviceKey,
    },
    input.approverInstanceId,
  );
}

function matchingCode(
  joinRequest: ReplicaJoinRequestFacts,
  approverInstanceId: ReplicaInstanceId,
): string {
  const preimage = buildReplicaJoinMatchingPreimage({ joinRequest, approverInstanceId });
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

type WriteResult =
  | { readonly status: "published" }
  | {
      readonly status: "failed";
      readonly phase: "entry" | "signature";
      readonly reason: "not-connected" | "refused" | "slot-occupied";
    };

type ReadResult =
  | { readonly status: "ready"; readonly bytes: Uint8Array }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly reason: "not-connected" | "refused" };

type LocalPublish =
  | { readonly status: "published"; readonly entry: ReplicaMembershipEntry }
  | { readonly status: "stopped"; readonly outcome: ReplicaMembershipOutcome };

export class ReplicaMembershipService {
  readonly #ports: ReplicaMembershipPorts;
  // Commands run one at a time: each one reads the next local sequence and
  // publishes into it, and two interleaved commands would race for one slot.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ports: ReplicaMembershipPorts) {
    this.#ports = ports;
  }

  execute(command: ReplicaMembershipCommand): Promise<ReplicaMembershipOutcome> {
    const run = this.#queue.then(() => this.#run(command));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #run(command: ReplicaMembershipCommand): Promise<ReplicaMembershipOutcome> {
    const selection = this.#ports.store();
    if (selection.status === "not-configured") {
      return this.#refuse(
        command.kind,
        "not-configured",
        "No replica store is set up on this computer.",
      );
    }
    const store = selection.store;
    if (
      command.kind === "write-join-request" ||
      command.kind === "approve-join" ||
      command.kind === "revoke"
    ) {
      // A local entry whose publish stopped part-way is finished before the
      // next decision, so that decision sees what the earlier one already did.
      const finished = await this.#finishPending(store, command.kind);
      if (finished !== undefined) return finished;
    }
    switch (command.kind) {
      case "create-replica":
        return this.#createReplica(store, command.displayName);
      case "write-join-request":
        return this.#writeJoinRequest(store, command.displayName);
      case "approve-join":
        return this.#approveJoin(store, command.joinRequest, command.confirmationCode);
      case "confirm-join":
        return this.#confirmJoin(store, command.approver, command.confirmationCode);
      case "revoke":
        return this.#revoke(store, command.subject);
      case "pull":
        return this.#pull(store);
    }
  }

  async #createReplica(
    store: ReplicaStore,
    displayName: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    // A revoked identity is finished; starting over is a new identity.
    if (state.local !== undefined && !isRevoked(state, state.local.instanceId)) {
      return this.#refuse(
        "create-replica",
        "already-member",
        "This computer already has an identity in a replica store.",
      );
    }
    const instanceId = this.#newInstanceId();
    let key: ReplicaDeviceSigningKey;
    try {
      key = await this.#ports.credentials.ensure(instanceId);
    } catch {
      return this.#refuse(
        "create-replica",
        "key-unavailable",
        "The device signing key could not be created.",
      );
    }
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-approved",
      origin: { instanceId, displayName, sequence: 1 },
      subject: instanceId,
      subjectDisplayName: displayName,
      subjectDeviceKey: key.publicKey,
    });
    const published = await this.#publishFirst(store, "create-replica", entry);
    if (published !== undefined) return published;
    return { kind: "replica-created", instanceId, entry };
  }

  async #writeJoinRequest(
    store: ReplicaStore,
    displayName: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const local = state.local;
    // Re-joining after a revocation is a new identity, not the old one back,
    // so a revoked computer falls through to a fresh instance below.
    if (local !== undefined && !isRevoked(state, local.instanceId)) {
      if (isMember(state, local.instanceId)) {
        return this.#refuse(
          "write-join-request",
          "already-member",
          "This computer is already a member.",
        );
      }
      // A computer that already asked writes a fresh request under the same
      // identity, so its approvers see one computer, not two.
      const publish = await this.#publishLocal(store, "write-join-request", (sequence) =>
        decodeReplicaMembershipEntry({
          format: REPLICA_ENTRY_FORMAT,
          kind: "join-request",
          origin: { instanceId: local.instanceId, displayName, sequence },
          subject: local.instanceId,
          subjectDisplayName: displayName,
          subjectDeviceKey: local.publicKey,
          requestedAt: this.#ports.clock(),
        }),
      );
      if (publish.status === "stopped") return publish.outcome;
      return { kind: "join-requested", instanceId: local.instanceId, entry: publish.entry };
    }
    const instanceId = this.#newInstanceId();
    let key: ReplicaDeviceSigningKey;
    try {
      key = await this.#ports.credentials.ensure(instanceId);
    } catch {
      return this.#refuse(
        "write-join-request",
        "key-unavailable",
        "The device signing key could not be created.",
      );
    }
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-request",
      origin: { instanceId, displayName, sequence: 1 },
      subject: instanceId,
      subjectDisplayName: displayName,
      subjectDeviceKey: key.publicKey,
      requestedAt: this.#ports.clock(),
    });
    const published = await this.#publishFirst(store, "write-join-request", entry);
    if (published !== undefined) return published;
    return { kind: "join-requested", instanceId, entry };
  }

  async #approveJoin(
    store: ReplicaStore,
    joinRequest: ReplicaMembershipEntry,
    confirmationCode: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const local = this.#localMember(state);
    if (local === undefined) {
      return this.#refuse(
        "approve-join",
        "not-a-member",
        "Only a member of the replica can approve a join.",
      );
    }
    const subject = joinRequest.subject;
    const deviceKey = joinRequest.subjectDeviceKey;
    const requestedAt = joinRequest.requestedAt;
    if (
      joinRequest.kind !== "join-request" ||
      deviceKey === undefined ||
      requestedAt === undefined
    ) {
      return this.#refuse(
        "approve-join",
        "not-a-member",
        "Only a join request can be approved.",
        subject,
      );
    }
    // The caller's copy proves nothing: the matching code is derived from
    // these same fields, so a request that was never written to the store -
    // or was rewritten since - would still match its own code. Approval is
    // published only for the entry the store holds and the joiner signed.
    const paths = replicaEntryRelativePaths(
      joinRequest.origin.instanceId,
      joinRequest.origin.sequence,
    );
    const stored = await readStore(store, paths.entry);
    const storedSignature = await readStore(store, paths.signature);
    for (const read of [stored, storedSignature]) {
      if (read.status === "unavailable") {
        this.#storeFailure({ phase: "read", reason: read.reason });
        return this.#refuse(
          "approve-join",
          "store-unavailable",
          "The replica store cannot be read.",
          subject,
        );
      }
    }
    if (stored.status !== "ready" || storedSignature.status !== "ready") {
      return this.#refuse(
        "approve-join",
        "unknown-instance",
        "No join request from that computer is in the store.",
        subject,
      );
    }
    if (
      decoder.decode(stored.bytes) !== encodeReplicaEntry(joinRequest) ||
      !verifyReplicaEntrySignature({
        publicKeyBase64: deviceKey,
        payload: stored.bytes,
        signatureBase64: decoder.decode(storedSignature.bytes),
      })
    ) {
      return this.#refuse(
        "approve-join",
        "code-mismatch",
        "The stored join request does not verify.",
        subject,
      );
    }
    if (!replicaJoinRequestIsFresh(requestedAt, this.#ports.clock())) {
      return this.#refuse(
        "approve-join",
        "expired-join-request",
        "That join request is no longer fresh.",
        subject,
      );
    }
    if (keyBelongsToRevoked(state, deviceKey)) {
      return this.#refuse(
        "approve-join",
        "revoked-instance",
        "That device key belongs to a revoked computer.",
        subject,
      );
    }
    const decision = decideReplicaJoinApproval({
      facts: domainFacts(state, local),
      joinRequest: {
        origin: {
          instanceId: joinRequest.origin.instanceId,
          displayName: joinRequest.origin.displayName,
        },
        subject,
        publicKey: deviceKey,
      },
    });
    if (decision.status === "refused") {
      return this.#refuse(
        "approve-join",
        decision.reason,
        decision.reason === "already-member"
          ? "That computer is already a member."
          : "That identity was revoked and cannot rejoin.",
        subject,
      );
    }
    const expected = deriveReplicaJoinMatchingCode({
      joinRequest,
      approverInstanceId: local.instanceId,
    });
    if (confirmationCode !== expected) {
      return this.#refuse(
        "approve-join",
        "code-mismatch",
        "The matching codes do not agree.",
        subject,
      );
    }
    const publish = await this.#publishLocal(store, "approve-join", (sequence) =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "join-approved",
        origin: { instanceId: local.instanceId, displayName: local.displayName, sequence },
        subject,
        subjectDisplayName: joinRequest.subjectDisplayName,
        subjectDeviceKey: deviceKey,
      }),
    );
    if (publish.status === "stopped") return publish.outcome;
    return { kind: "join-approved", subject, entry: publish.entry };
  }

  /**
   * The joining computer's half of a join: after the person compared codes, it
   * reads the approver's signed records and journals the approver as a member.
   * That journal record is what later lets this computer accept the
   * approver's entries; a store record alone cannot bootstrap that trust.
   */
  async #confirmJoin(
    store: ReplicaStore,
    approver: ReplicaInstanceId,
    confirmationCode: string,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const local = state.local;
    if (local === undefined) {
      return this.#refuse(
        "confirm-join",
        "not-a-member",
        "This computer has not asked to join a replica.",
        approver,
      );
    }
    if (isRevoked(state, local.instanceId)) {
      return this.#refuse(
        "confirm-join",
        "revoked-instance",
        "This instance was revoked and cannot rejoin.",
        approver,
      );
    }
    if (isMember(state, local.instanceId)) {
      return this.#refuse(
        "confirm-join",
        "already-member",
        "This computer is already a member.",
        approver,
      );
    }
    if (String(approver) === String(local.instanceId) || isRevoked(state, approver)) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "That computer cannot approve this one.",
        approver,
      );
    }
    const expected = matchingCode(
      {
        origin: { instanceId: local.instanceId, displayName: local.displayName },
        subject: local.instanceId,
        publicKey: local.publicKey,
      },
      approver,
    );
    if (confirmationCode !== expected) {
      return this.#refuse(
        "confirm-join",
        "code-mismatch",
        "The matching codes do not agree.",
        approver,
      );
    }
    // The approver's first entry names its own device key and is signed by
    // it: a founding self-approval, or its own join request.
    const founding = await this.#readSigned(store, approver, 1);
    if (founding.status === "unavailable") {
      return this.#refuse(
        "confirm-join",
        "store-unavailable",
        "The replica store cannot be read.",
        approver,
      );
    }
    const identity =
      founding.status === "ready" &&
      (founding.entry.kind === "join-approved" || founding.entry.kind === "join-request") &&
      String(founding.entry.subject) === String(approver)
        ? founding.entry
        : undefined;
    const approverKey = identity?.subjectDeviceKey;
    if (
      founding.status !== "ready" ||
      identity === undefined ||
      approverKey === undefined ||
      verdictFor(approverKey, founding) !== "verified"
    ) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        "That computer has no signed identity in the store.",
        approver,
      );
    }
    for (let sequence = 2; sequence <= MAX_ENTRIES_PER_INSTANCE; sequence += 1) {
      const read = await this.#readSigned(store, approver, sequence);
      if (read.status === "unavailable") {
        return this.#refuse(
          "confirm-join",
          "store-unavailable",
          "The replica store cannot be read.",
          approver,
        );
      }
      if (read.status === "missing") break;
      if (read.status !== "ready") continue;
      const approval = read.entry;
      if (
        approval.kind === "join-approved" &&
        String(approval.subject) === String(local.instanceId) &&
        approval.subjectDeviceKey === local.publicKey &&
        verdictFor(approverKey, read) === "verified"
      ) {
        this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinConfirmed, {
          approver,
          approverDisplayName: identity.subjectDisplayName,
          approverDeviceKey: approverKey,
          approvalSequence: sequence,
        });
        return { kind: "join-confirmed", approver };
      }
    }
    return this.#refuse(
      "confirm-join",
      "unknown-instance",
      "No signed approval of this computer from that member is in the store.",
      approver,
    );
  }

  async #revoke(
    store: ReplicaStore,
    subject: ReplicaInstanceId,
  ): Promise<ReplicaMembershipOutcome> {
    const state = this.#ports.state();
    const local = this.#localMember(state);
    if (local === undefined) {
      return this.#refuse(
        "revoke",
        "not-a-member",
        "Only a member of the replica can revoke another computer.",
        subject,
      );
    }
    const decision = decideReplicaRevocation(domainFacts(state, local), subject);
    const member = state.members.find((m) => String(m.instanceId) === String(subject));
    if (decision.status === "refused" || member === undefined) {
      const reason = decision.status === "refused" ? decision.reason : "unknown-instance";
      return this.#refuse(
        "revoke",
        reason,
        reason === "unknown-instance"
          ? "No member has that id."
          : reason === "not-a-member"
            ? "That computer is not a member."
            : "That identity is already revoked.",
        subject,
      );
    }
    const publish = await this.#publishLocal(store, "revoke", (sequence) =>
      decodeReplicaMembershipEntry({
        format: REPLICA_ENTRY_FORMAT,
        kind: "revocation",
        origin: { instanceId: local.instanceId, displayName: local.displayName, sequence },
        subject,
        subjectDisplayName: member.displayName,
      }),
    );
    if (publish.status === "stopped") return publish.outcome;
    return { kind: "revoked", subject, entry: publish.entry };
  }

  /**
   * Read every other instance's entries and apply the ones that verify.
   *
   * Each instance is walked in sequence order from the first entry this host
   * has not applied. An entry is verified against the device key its origin
   * holds as a member here - a key the journal recorded, never one the entry
   * names for itself, except a join request, which is the one record a
   * computer that is not yet a member may sign with its own key. A bad or
   * missing signature, an unknown or revoked origin, a body whose origin is
   * not its path, a gap, or a rewritten sequence is refused and journaled, and
   * the walk for that instance stops there: nothing later from it is applied
   * while an earlier entry is missing or refused.
   */
  async #pull(store: ReplicaStore): Promise<ReplicaMembershipOutcome> {
    const initial = this.#ports.state();
    const local = this.#localMember(initial);
    if (local === undefined) {
      return this.#refuse(
        "pull",
        "not-a-member",
        "Only a member of the replica reads other computers' entries.",
      );
    }
    const listing = await this.#listInstances(store);
    if (listing === undefined) {
      return this.#refuse("pull", "store-unavailable", "The replica store cannot be listed.");
    }
    let applied = 0;
    const refused: ReplicaReadRefusal[] = [];
    const held: { instanceId: ReplicaInstanceId; sequence: number }[] = [];
    const instances = [...listing.keys()].sort();
    for (const id of instances) {
      if (id === String(local.instanceId)) continue;
      const sequences = listing.get(id);
      if (sequences === undefined) continue;
      const instanceId = decodeInstanceId(id);
      const walk = await this.#walkInstance(store, instanceId, sequences, local);
      if (walk.status === "unavailable") {
        return this.#refuse("pull", "store-unavailable", "The replica store cannot be read.");
      }
      applied += walk.applied;
      if (walk.refused !== undefined) refused.push(walk.refused);
      if (walk.held !== undefined) held.push(walk.held);
    }
    const now = this.#ports.clock();
    const after = this.#ports.state();
    const joinRequests = after.joinRequests.filter(
      (entry) =>
        entry.requestedAt !== undefined &&
        replicaJoinRequestIsFresh(entry.requestedAt, now) &&
        !isMember(after, entry.subject) &&
        !isRevoked(after, entry.subject),
    );
    return { kind: "pulled", applied, refused, held, joinRequests };
  }

  async #walkInstance(
    store: ReplicaStore,
    instanceId: ReplicaInstanceId,
    sequences: ReadonlySet<number>,
    local: ReplicaLocalIdentity,
  ): Promise<
    | { readonly status: "unavailable" }
    | {
        readonly status: "walked";
        readonly applied: number;
        readonly refused?: ReplicaReadRefusal;
        readonly held?: { readonly instanceId: ReplicaInstanceId; readonly sequence: number };
      }
  > {
    let applied = 0;
    let sequence = highestApplied(this.#ports.state(), instanceId) + 1;
    const highest = Math.max(0, ...sequences);
    for (; sequence <= Math.min(highest, MAX_ENTRIES_PER_INSTANCE); sequence += 1) {
      if (!sequences.has(sequence)) {
        const next = [...sequences].filter((s) => s > sequence).sort((a, b) => a - b)[0];
        if (next === undefined) break;
        return {
          status: "walked",
          applied,
          refused: this.#refuseRead({ instanceId, sequence: next, reason: "sequence-gap" }),
        };
      }
      const read = await this.#readSigned(store, instanceId, sequence);
      if (read.status === "unavailable") return { status: "unavailable" };
      if (read.status === "missing") break;
      if (read.status === "unreadable" || read.status === "path-mismatch") {
        return {
          status: "walked",
          applied,
          refused: this.#refuseRead({ instanceId, sequence, reason: read.status }),
        };
      }
      const state = this.#ports.state();
      const decision = this.#decideRead(state, local, read);
      if (decision.outcome === "refused") {
        return {
          status: "walked",
          applied,
          refused: this.#refuseRead({ instanceId, sequence, reason: decision.reason }),
        };
      }
      const entry = read.entry;
      if (entry.kind === "artifact-version" || entry.kind === "artifact-tombstone") {
        // Importing an artifact version is not built yet. The entry verified,
        // but marking it applied would make the later import skip it, so the
        // walk stops here and a later pull reads it again.
        return { status: "walked", applied, held: { instanceId, sequence } };
      }
      const outcome = decision.outcome;
      if (
        outcome !== "request-approval" &&
        outcome !== "member-added" &&
        outcome !== "member-revoked" &&
        outcome !== "already-present"
      ) {
        throw new Error(`A membership entry reconciled to ${outcome}.`);
      }
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.entryApplied, { entry, outcome });
      applied += 1;
    }
    return { status: "walked", applied };
  }

  #decideRead(
    state: ReplicaMembershipState,
    local: ReplicaLocalIdentity,
    read: Extract<SignedRead, { status: "ready" }>,
  ): ReturnType<typeof reconcileReplicaEntry> {
    const entry = read.entry;
    const origin = entry.origin.instanceId;
    if (isRevoked(state, origin)) return { outcome: "refused", reason: "revoked-instance" };
    const facts = domainFacts(state, local);
    const member = state.members.find((m) => String(m.instanceId) === String(origin));
    let key: string | undefined;
    if (member !== undefined && replicaMembershipAcceptsKey(facts, origin, member.publicKey)) {
      key = member.publicKey;
    } else if (entry.kind === "join-request") {
      key = entry.subjectDeviceKey;
    }
    if (key === undefined) return { outcome: "refused", reason: "unknown-instance" };
    // A new identity carrying a revoked computer's key is that computer back
    // under another name, so its request or approval is refused.
    if (
      (entry.kind === "join-request" || entry.kind === "join-approved") &&
      entry.subjectDeviceKey !== undefined &&
      keyBelongsToRevoked(state, entry.subjectDeviceKey)
    ) {
      return { outcome: "refused", reason: "revoked-instance" };
    }
    const localState: ReplicaLocalState = {
      localHostId: this.#ports.localHostId,
      localInstanceId: local.instanceId,
      instances: [
        ...state.members.map((m) => ({ instanceId: m.instanceId, status: "member" as const })),
        ...state.revocations.map((id) => ({ instanceId: id, status: "revoked" as const })),
      ],
      applied: state.applied,
      // Artifact entries are held, not applied, so no local artifact facts
      // are needed to decide them yet.
      artifacts: [],
      measuredContentHash:
        entry.kind === "artifact-version" || entry.kind === "artifact-tombstone"
          ? createHash("sha256").update(replicaEntryContentPreimage(entry), "utf8").digest("hex")
          : "",
      signature: verdictFor(key, read),
    };
    return reconcileReplicaEntry(localState, entry);
  }

  async #listInstances(
    store: ReplicaStore,
  ): Promise<ReadonlyMap<string, ReadonlySet<number>> | undefined> {
    const instances = new Map<string, Set<number>>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const listed = await store.list(cursor);
      if (listed.status !== "ready") {
        this.#storeFailure({ phase: "list", reason: listed.status });
        return undefined;
      }
      for (const { key } of listed.entries) {
        const match = ENTRY_KEY.exec(key);
        if (match === null || match[3] !== "json") continue;
        const id = match[1];
        const sequence = Number(match[2]);
        if (id === undefined || !Number.isSafeInteger(sequence)) continue;
        const known = instances.get(id) ?? new Set<number>();
        known.add(sequence);
        instances.set(id, known);
      }
      if (listed.nextCursor === undefined) return instances;
      cursor = listed.nextCursor;
    }
    // A listing that does not end inside the bound is refused, not read in
    // part: a partial view would skip whole instances - their revocations
    // too - without saying so.
    this.#storeFailure({ phase: "list", reason: "truncated" });
    return undefined;
  }

  async #readSigned(
    store: ReplicaStore,
    instanceId: ReplicaInstanceId,
    sequence: number,
  ): Promise<SignedRead> {
    const paths = replicaEntryRelativePaths(instanceId, sequence);
    const body = await readStore(store, paths.entry);
    if (body.status === "unavailable") {
      this.#storeFailure({ phase: "read", reason: body.reason, instanceId, sequence });
      return { status: "unavailable" };
    }
    if (body.status === "missing") return { status: "missing" };
    let entry: ReplicaEntry;
    try {
      entry = decodeReplicaEntryText(decoder.decode(body.bytes));
    } catch {
      return { status: "unreadable" };
    }
    if (
      String(entry.origin.instanceId) !== String(instanceId) ||
      entry.origin.sequence !== sequence
    ) {
      return { status: "path-mismatch" };
    }
    const signature = await readStore(store, paths.signature);
    if (signature.status === "unavailable") {
      this.#storeFailure({ phase: "read", reason: signature.reason, instanceId, sequence });
      return { status: "unavailable" };
    }
    return {
      status: "ready",
      entry,
      bytes: body.bytes,
      ...(signature.status === "ready" ? { signature: decoder.decode(signature.bytes) } : {}),
    };
  }

  /**
   * Publish the first entry of a fresh identity. Nobody can accept an identity
   * whose first entry did not land, so a failure abandons it and the next
   * attempt starts a new one.
   */
  async #publishFirst(
    store: ReplicaStore,
    command: "create-replica" | "write-join-request",
    entry: ReplicaMembershipEntry,
  ): Promise<ReplicaMembershipOutcome | undefined> {
    const encoded = encoder.encode(encodeReplicaEntry(entry));
    let signature: string;
    try {
      signature = (await this.#ports.credentials.sign(entry.origin.instanceId, encoded)).signature;
    } catch {
      return this.#refuse(command, "key-unavailable", "The entry could not be signed.");
    }
    const written = await writeSigned(store, entry, encoded, signature);
    if (written.status === "failed") return this.#publishFailed(entry, written);
    this.#journalPublished(entry);
    return undefined;
  }

  /**
   * Publish an entry under this host's established identity at its next
   * sequence.
   *
   * The signed entry is journaled before either file is written. If the
   * publish stops part-way, the next command finishes it first with the same
   * bytes and the same signature - Ed25519 signs deterministically - so a
   * write-once signature already in the slot matches instead of blocking that
   * sequence forever.
   */
  async #publishLocal(
    store: ReplicaStore,
    command: "write-join-request" | "approve-join" | "revoke",
    build: (sequence: number) => ReplicaMembershipEntry,
  ): Promise<LocalPublish> {
    const entry = build(this.#ports.state().localSequence + 1);
    const encoded = encoder.encode(encodeReplicaEntry(entry));
    let signature: string;
    try {
      signature = (await this.#ports.credentials.sign(entry.origin.instanceId, encoded)).signature;
    } catch {
      return {
        status: "stopped",
        outcome: this.#refuse(command, "key-unavailable", "The entry could not be signed."),
      };
    }
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.entrySigned, { entry });
    const written = await writeSigned(store, entry, encoded, signature);
    if (written.status === "failed") {
      return { status: "stopped", outcome: this.#publishFailed(entry, written) };
    }
    this.#journalPublished(entry);
    return { status: "published", entry };
  }

  async #finishPending(
    store: ReplicaStore,
    command: "write-join-request" | "approve-join" | "revoke",
  ): Promise<ReplicaMembershipOutcome | undefined> {
    const state = this.#ports.state();
    const entry = state.pending;
    if (entry === undefined) return undefined;
    // A revoked identity's stopped publish is dropped, not finished: its
    // signature would be one the other computers refuse anyway, and the slot
    // belongs to an identity this computer no longer writes as.
    if (state.local === undefined || isRevoked(state, state.local.instanceId)) return undefined;
    const encoded = encoder.encode(encodeReplicaEntry(entry));
    let signature: string;
    try {
      signature = (await this.#ports.credentials.sign(entry.origin.instanceId, encoded)).signature;
    } catch {
      return this.#refuse(command, "key-unavailable", "The entry could not be signed.");
    }
    const written = await writeSigned(store, entry, encoded, signature);
    if (written.status === "failed") return this.#publishFailed(entry, written);
    this.#journalPublished(entry);
    return undefined;
  }

  #publishFailed(
    entry: ReplicaMembershipEntry,
    failure: Extract<WriteResult, { status: "failed" }>,
  ): ReplicaMembershipOutcome {
    this.#storeFailure({
      phase: failure.phase,
      reason: failure.reason,
      instanceId: entry.origin.instanceId,
      sequence: entry.origin.sequence,
    });
    return {
      kind: "store-failed",
      message:
        failure.phase === "signature"
          ? "The replica store did not take the signature."
          : "The replica store did not take the entry.",
    };
  }

  /** Journal what a published local entry means, so the facts include it. */
  #journalPublished(entry: ReplicaMembershipEntry): void {
    const names = REPLICA_MEMBERSHIP_EVENT_NAMES;
    const sequence = entry.origin.sequence;
    if (entry.kind === "join-request" && entry.subjectDeviceKey !== undefined) {
      this.#journal(names.joinRequested, {
        instanceId: entry.origin.instanceId,
        displayName: entry.subjectDisplayName,
        publicKey: entry.subjectDeviceKey,
        sequence,
        requestedAt: entry.requestedAt ?? 0,
      });
      return;
    }
    if (entry.kind === "join-approved" && entry.subjectDeviceKey !== undefined) {
      if (String(entry.subject) === String(entry.origin.instanceId)) {
        this.#journal(names.replicaCreated, {
          instanceId: entry.origin.instanceId,
          displayName: entry.subjectDisplayName,
          publicKey: entry.subjectDeviceKey,
          sequence,
        });
        return;
      }
      this.#journal(names.joinApproved, {
        approver: entry.origin.instanceId,
        sequence,
        subject: entry.subject,
        subjectDisplayName: entry.subjectDisplayName,
        subjectDeviceKey: entry.subjectDeviceKey,
      });
      return;
    }
    if (entry.kind === "revocation") {
      this.#journal(names.revoked, {
        revoker: entry.origin.instanceId,
        sequence,
        subject: entry.subject,
      });
    }
  }

  #localMember(state: ReplicaMembershipState): ReplicaLocalIdentity | undefined {
    const local = state.local;
    if (local === undefined) return undefined;
    if (isRevoked(state, local.instanceId) || !isMember(state, local.instanceId)) return undefined;
    return local;
  }

  #newInstanceId(): ReplicaInstanceId {
    return this.#ports.newInstanceId?.() ?? decodeInstanceId(randomUUID());
  }

  #refuseRead(refusal: ReplicaReadRefusal): ReplicaReadRefusal {
    // A refusal is journaled once. A later pull meets the same file again
    // until it changes, and repeating the record would say nothing new.
    if (!this.#ports.state().refusalRecorded(refusal)) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.entryRefused, refusal);
    }
    return refusal;
  }

  #storeFailure(input: {
    readonly phase: "entry" | "signature" | "read" | "list";
    readonly reason: "not-connected" | "refused" | "slot-occupied" | "truncated";
    readonly instanceId?: ReplicaInstanceId;
    readonly sequence?: number;
  }): void {
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure, input);
  }

  #journal(eventName: string, payload: unknown): void {
    this.#ports.journal.append({ eventName, payload });
  }

  #refuse(
    command: ReplicaMembershipCommand["kind"],
    reason: RefusalReason,
    message: string,
    subject?: ReplicaInstanceId,
  ): ReplicaMembershipOutcome {
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.commandRefused, {
      command,
      reason,
      ...(subject === undefined ? {} : { subject }),
    });
    return { kind: "refused", reason, message };
  }
}

type SignedRead =
  | {
      readonly status: "ready";
      readonly entry: ReplicaEntry;
      readonly bytes: Uint8Array;
      readonly signature?: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "unreadable" }
  | { readonly status: "path-mismatch" }
  | { readonly status: "unavailable" };

function verdictFor(
  publicKey: string,
  read: Extract<SignedRead, { status: "ready" }>,
): ReplicaSignatureVerdict {
  if (read.signature === undefined) return "missing";
  return verifyReplicaEntrySignature({
    publicKeyBase64: publicKey,
    payload: read.bytes,
    signatureBase64: read.signature,
  })
    ? "verified"
    : "bad-signature";
}

async function readStore(store: ReplicaStore, key: string): Promise<ReadResult> {
  const read = await store.get(key);
  if (read.status === "ready") return { status: "ready", bytes: read.bytes };
  if (read.status === "missing") return { status: "missing" };
  return { status: "unavailable", reason: read.status };
}

/**
 * Write the signature, then the entry, each write-once. The signature goes in
 * first, so a reader that finds an entry finds its signature beside it. A key
 * that already holds exactly these bytes is this same publish finished
 * earlier, not a conflict.
 */
async function writeSigned(
  store: ReplicaStore,
  entry: ReplicaMembershipEntry,
  encoded: Uint8Array,
  signature: string,
): Promise<WriteResult> {
  const paths = replicaEntryRelativePaths(entry.origin.instanceId, entry.origin.sequence);
  const signatureWrite = await putOnce(store, paths.signature, encoder.encode(signature));
  if (signatureWrite !== "stored") {
    return { status: "failed", phase: "signature", reason: signatureWrite };
  }
  const entryWrite = await putOnce(store, paths.entry, encoded);
  if (entryWrite !== "stored") return { status: "failed", phase: "entry", reason: entryWrite };
  return { status: "published" };
}

async function putOnce(
  store: ReplicaStore,
  key: string,
  bytes: Uint8Array,
): Promise<"stored" | "not-connected" | "refused" | "slot-occupied"> {
  const put = await store.putIfAbsent(key, bytes);
  if (put.status === "stored") return "stored";
  if (put.status === "not-connected" || put.status === "refused") return put.status;
  const existing = await readStore(store, key);
  if (existing.status === "unavailable") return existing.reason;
  if (existing.status === "ready" && sameBytes(existing.bytes, bytes)) return "stored";
  return "slot-occupied";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function domainFacts(
  state: ReplicaMembershipState,
  local: ReplicaLocalIdentity,
): ReplicaMembershipFacts {
  return {
    localInstanceId: local.instanceId,
    members: state.members,
    revocations: state.revocations,
  };
}

function isMember(state: ReplicaMembershipState, instanceId: ReplicaInstanceId): boolean {
  return state.members.some((member) => String(member.instanceId) === String(instanceId));
}

function isRevoked(state: ReplicaMembershipState, instanceId: ReplicaInstanceId): boolean {
  return state.revocations.some((revoked) => String(revoked) === String(instanceId));
}

function keyBelongsToRevoked(state: ReplicaMembershipState, publicKey: string): boolean {
  return state.members.some(
    (member) => member.publicKey === publicKey && isRevoked(state, member.instanceId),
  );
}

function highestApplied(state: ReplicaMembershipState, instanceId: ReplicaInstanceId): number {
  let highest = 0;
  for (const applied of state.applied) {
    if (String(applied.instanceId) === String(instanceId) && applied.sequence > highest) {
      highest = applied.sequence;
    }
  }
  return highest;
}
