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
  deriveReplicaMembership,
  replicaJoinRequestIsFresh,
  revocationCut,
  type ReplicaAdmissionRecord,
  type ReplicaJoinRequestFacts,
  type ReplicaJoinRequestKey,
  type ReplicaMembershipFacts,
  type ReplicaRevocationRecord,
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

/** An instance and the device key it signs with. */
interface KeyedInstance {
  readonly instanceId: ReplicaInstanceId;
  readonly publicKey: string;
}

/**
 * The six-digit code a person compares between the joining computer and the
 * approving one.
 *
 * It is a SHA-256 digest, reduced to six digits, of the joiner's instance id,
 * name, and device public key, the approver's instance id and device key, and
 * the founder's instance id and key. The approver computes it from what it
 * holds; the joining computer computes it from the chain of signed approvals
 * it reads from the store. Equal codes mean both screens describe the same
 * join request, the same approver key, and the same founder, so a person
 * notices a request from a different computer - or a chain someone with write
 * access to the store forged for the approver - before it takes effect. It is
 * not a secret and proves nothing by itself: anyone who can read the store can
 * compute it, and six digits leave room for a party that can also write the
 * store to search keys offline until one collides. What makes the approval
 * authoritative is the signatures on the stored records; the code binds a
 * person's comparison to them.
 */
export function deriveReplicaJoinMatchingCode(input: {
  readonly joinRequest: ReplicaMembershipEntry;
  readonly approver: KeyedInstance;
  readonly founder: KeyedInstance;
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
    input.approver,
    input.founder,
  );
}

function matchingCode(
  joinRequest: ReplicaJoinRequestFacts,
  approver: KeyedInstance,
  founder: KeyedInstance,
): string {
  const preimage = buildReplicaJoinMatchingPreimage({ joinRequest, approver, founder });
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
    // A finished identity cannot come back; starting over is a new identity.
    if (state.local !== undefined && !identityFinished(state)) {
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
    // Re-joining after a revocation, or after a cut removed the approval that
    // admitted this computer, is a new identity, not the old one back. The old
    // identity's log may hold entries every reader refuses, and a request
    // written behind them would never be read.
    if (local !== undefined && !identityFinished(state)) {
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
    if (keyBelongsToAnotherRevoked(state, deviceKey, subject)) {
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
    const founder = state.founder;
    if (founder === undefined) {
      return this.#refuse(
        "approve-join",
        "not-a-member",
        "This computer holds no founder to name in the matching code.",
        subject,
      );
    }
    const expected = deriveReplicaJoinMatchingCode({ joinRequest, approver: local, founder });
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
    if (identityFinished(state)) {
      return this.#refuse(
        "confirm-join",
        "revoked-instance",
        "This identity is no longer a member and cannot rejoin; ask to join again.",
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
    const records = await this.#readMembershipLogs(store);
    if (records === undefined) {
      return this.#refuse(
        "confirm-join",
        "store-unavailable",
        "The replica store cannot be read.",
        approver,
      );
    }
    const chains = founderChainsTo(records, approver, local);
    if (chains.length !== 1) {
      return this.#refuse(
        "confirm-join",
        "unknown-instance",
        chains.length === 0
          ? "No signed chain of approvals from the founder to this computer is in the store."
          : "The store holds more than one founder that approved that computer; joining is refused.",
        approver,
      );
    }
    const [chain] = chains;
    if (chain === undefined) {
      throw new Error("A single founder chain was counted but not found.");
    }
    // The code names the approver's key and the founder as this computer read
    // them from the chain. The approver computed its code from its own key
    // and founder, so a chain someone forged in the store gives another code.
    const expected = matchingCode(
      {
        origin: { instanceId: local.instanceId, displayName: local.displayName },
        subject: local.instanceId,
        publicKey: local.publicKey,
      },
      { instanceId: approver, publicKey: chain.approverKey },
      chain.founder,
    );
    if (confirmationCode !== expected) {
      return this.#refuse(
        "confirm-join",
        "code-mismatch",
        "The matching codes do not agree.",
        approver,
      );
    }
    if (!chain.admitsLocal) {
      return this.#refuse(
        "confirm-join",
        "revoked-instance",
        "A revocation in the store cuts the approval that would admit this computer.",
        approver,
      );
    }
    const final = chain.links.at(-1);
    if (final === undefined) throw new Error("A founder chain without its final approval.");
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinConfirmed, {
      approver,
      approverDisplayName: chain.approverDisplayName,
      approverDeviceKey: chain.approverKey,
      approvalSequence: final.sequence,
      founder: chain.founder,
      links: chain.links,
    });
    return { kind: "join-confirmed", approver };
  }

  /**
   * Every instance's first join request, approvals, and revocations, read in
   * sequence order up to the first gap.
   */
  async #readMembershipLogs(
    store: ReplicaStore,
  ): Promise<ReadonlyArray<MembershipRecord> | undefined> {
    const listing = await this.#listInstances(store);
    if (listing === undefined) return undefined;
    const records: MembershipRecord[] = [];
    for (const [id, sequences] of listing) {
      const instanceId = decodeInstanceId(id);
      const highest = Math.min(Math.max(0, ...sequences), MAX_ENTRIES_PER_INSTANCE);
      for (let sequence = 1; sequence <= highest; sequence += 1) {
        if (!sequences.has(sequence)) break;
        const read = await this.#readSigned(store, instanceId, sequence);
        if (read.status === "unavailable") return undefined;
        if (read.status !== "ready") break;
        const entry = read.entry;
        if (
          entry.kind === "join-approved" ||
          entry.kind === "revocation" ||
          (entry.kind === "join-request" && sequence === 1)
        ) {
          records.push({ entry, read });
        }
      }
    }
    return records;
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
        // The cut: the last of the revoked computer's entries this one holds -
        // what it applied, and any approval it holds through the chain it
        // joined by - so the cut never falls before the approval that admitted
        // this computer. Every entry it signed later stops counting everywhere.
        lastAcceptedSequence: state.heldSequence(subject),
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
   * missing signature, an unknown origin, a body whose origin is not its
   * path, a gap, or a rewritten sequence is refused and journaled, and the
   * walk for that instance stops there: nothing later from it is applied
   * while an earlier entry is missing or refused.
   *
   * An approval or revocation from a known origin is kept even past a cut on
   * that origin; membership weighs every record it holds, and one past a cut
   * does not count. Logs are walked again while a walk still applies
   * something, so an origin this host only learns about from a log it reads
   * later in the same pull is not refused for the order the store listed it
   * in. Only what is still refused when nothing more applies is journaled.
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
    const instances = [...listing.keys()].sort().filter((id) => id !== String(local.instanceId));
    let applied = 0;
    let stopped: ReadonlyArray<{
      readonly refused?: ReplicaReadRefusal;
      readonly held?: { readonly instanceId: ReplicaInstanceId; readonly sequence: number };
    }> = [];
    // Each pass that applies something adds a record, so the passes end.
    for (let pass = 0; pass <= instances.length; pass += 1) {
      let progress = 0;
      const walks = [];
      for (const id of instances) {
        const sequences = listing.get(id);
        if (sequences === undefined) continue;
        const walk = await this.#walkInstance(store, decodeInstanceId(id), sequences, local);
        if (walk.status === "unavailable") {
          return this.#refuse("pull", "store-unavailable", "The replica store cannot be read.");
        }
        progress += walk.applied;
        walks.push(walk);
      }
      applied += progress;
      stopped = walks;
      if (progress === 0) break;
    }
    const refused: ReplicaReadRefusal[] = [];
    const held: { instanceId: ReplicaInstanceId; sequence: number }[] = [];
    for (const walk of stopped) {
      if (walk.refused !== undefined) refused.push(this.#refuseRead(walk.refused));
      if (walk.held !== undefined) held.push(walk.held);
    }
    // An entry applied from an instance that a revocation cuts - read later in
    // this pull, or in an earlier one - does not count past that cut. It is
    // reported refused once, and membership no longer counts it.
    for (const entry of this.#ports.state().applied) {
      const cut = revocationCut(this.#ports.state(), entry.instanceId);
      if (cut === undefined || entry.sequence <= cut) continue;
      const refusal: ReplicaReadRefusal = {
        instanceId: entry.instanceId,
        sequence: entry.sequence,
        reason: "revoked-instance",
      };
      if (this.#ports.state().refusalRecorded(refusal)) continue;
      refused.push(this.#refuseRead(refusal));
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

  /** Walk one instance's log; a refusal it ends on is returned, not journaled. */
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
          refused: { instanceId, sequence: next, reason: "sequence-gap" },
        };
      }
      const read = await this.#readSigned(store, instanceId, sequence);
      if (read.status === "unavailable") return { status: "unavailable" };
      if (read.status === "missing") break;
      if (read.status === "unreadable" || read.status === "path-mismatch") {
        return {
          status: "walked",
          applied,
          refused: { instanceId, sequence, reason: read.status },
        };
      }
      const state = this.#ports.state();
      const decision = this.#decideRead(state, local, read);
      if (decision.outcome === "refused") {
        return {
          status: "walked",
          applied,
          refused: { instanceId, sequence, reason: decision.reason },
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
    // The key the journal holds for the origin verifies its entries, whether
    // or not a cut stops them counting; the reconcile policy refuses an
    // artifact entry past a cut, and membership weighs a membership record.
    const member = state.members.find((m) => String(m.instanceId) === String(origin));
    let key: string | undefined = member?.publicKey;
    if (key === undefined && entry.kind === "join-request") key = entry.subjectDeviceKey;
    if (key === undefined) return { outcome: "refused", reason: "unknown-instance" };
    // A new identity asking with a revoked computer's key is that computer
    // back under another name. Its own records keep their key.
    if (
      entry.kind === "join-request" &&
      entry.subjectDeviceKey !== undefined &&
      keyBelongsToAnotherRevoked(state, entry.subjectDeviceKey, entry.subject)
    ) {
      return { outcome: "refused", reason: "revoked-instance" };
    }
    const localState: ReplicaLocalState = {
      localHostId: this.#ports.localHostId,
      localInstanceId: local.instanceId,
      instances: [
        ...state.members.map((m) => ({ instanceId: m.instanceId, status: "member" as const })),
        ...state.revocations.map((revoked) => ({
          instanceId: revoked.instanceId,
          status: "revoked" as const,
          lastAcceptedSequence: revoked.lastAcceptedSequence,
        })),
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
    if (state.local === undefined || identityFinished(state)) return undefined;
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
        lastAcceptedSequence: entry.lastAcceptedSequence ?? 0,
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

interface MembershipRecord {
  readonly entry: ReplicaMembershipEntry;
  readonly read: Extract<SignedRead, { status: "ready" }>;
}

interface FounderChainLink {
  readonly approver: ReplicaInstanceId;
  readonly sequence: number;
  readonly subject: ReplicaInstanceId;
  readonly subjectDisplayName: string;
  readonly subjectDeviceKey: string;
}

interface FounderChain {
  readonly founder: {
    readonly instanceId: ReplicaInstanceId;
    readonly displayName: string;
    readonly publicKey: string;
  };
  readonly approverDisplayName: string;
  readonly approverKey: string;
  /** Founder to approver, then the approver's approval of this computer. */
  readonly links: ReadonlyArray<FounderChainLink>;
  /**
   * Whether this computer is a member once every verified approval and
   * revocation in the store under this founder is weighed - false when a
   * revocation already cuts an approval the chain depends on.
   */
  readonly admitsLocal: boolean;
}

/**
 * The chains of approvals from a founder to `approver`, ending in the
 * approver's approval of this computer.
 *
 * A founding record is the sequence-1 self-approval an instance signed with
 * the key it names; it counts only as the start of a chain. Each approval
 * after it must verify against the key the previous verified link named for
 * its approver and name the key of its subject's own first join request, so a
 * record anyone could write - a self-approval, an approval signed with a key
 * nobody vouched for, or a member's approval that names its own key for
 * another computer - cannot enter a chain. One
 * chain is kept per founder; a caller refuses when more than one founder
 * reaches the approver, because a second founding record is what a stranger
 * with write access to the store would add.
 *
 * Revocations signed by an instance the chain reaches are verified the same
 * way and weighed with every reached approval, as a pull would weigh them, so
 * a join through an approval a revocation already cut is not reported as
 * confirmed.
 */
function founderChainsTo(
  records: ReadonlyArray<MembershipRecord>,
  approver: ReplicaInstanceId,
  local: ReplicaLocalIdentity,
): ReadonlyArray<FounderChain> {
  const chains: FounderChain[] = [];
  // Each instance's own first join request, verified with the key it names:
  // the only key an approval of that instance may carry.
  const requests: ReplicaJoinRequestKey[] = [];
  for (const { entry, read } of records) {
    const key = entry.subjectDeviceKey;
    if (
      entry.kind === "join-request" &&
      entry.origin.sequence === 1 &&
      key !== undefined &&
      verdictFor(key, read) === "verified"
    ) {
      requests.push({ instanceId: entry.origin.instanceId, publicKey: key });
    }
  }
  const requested = (instanceId: ReplicaInstanceId, publicKey: string) =>
    requests.some(
      (request) =>
        String(request.instanceId) === String(instanceId) && request.publicKey === publicKey,
    );
  for (const founding of records) {
    const { entry } = founding;
    const key = entry.subjectDeviceKey;
    if (
      entry.kind !== "join-approved" ||
      entry.origin.sequence !== 1 ||
      String(entry.subject) !== String(entry.origin.instanceId) ||
      key === undefined ||
      verdictFor(key, founding.read) !== "verified"
    ) {
      continue;
    }
    const founder = {
      instanceId: entry.origin.instanceId,
      displayName: entry.subjectDisplayName,
      publicKey: key,
    };
    // Breadth first from the founder: each reached instance with the key the
    // link that reached it named, and the links that reached it.
    const reached = new Map<
      string,
      { readonly key: string; readonly name: string; readonly links: FounderChainLink[] }
    >([[String(founder.instanceId), { key, name: founder.displayName, links: [] }]]);
    const queue = [String(founder.instanceId)];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const at = reached.get(current);
      if (at === undefined) continue;
      for (const approval of records) {
        const subjectKey = approval.entry.subjectDeviceKey;
        if (
          approval.entry.kind !== "join-approved" ||
          String(approval.entry.origin.instanceId) !== current ||
          String(approval.entry.subject) === current ||
          subjectKey === undefined ||
          !requested(approval.entry.subject, subjectKey) ||
          reached.has(String(approval.entry.subject)) ||
          verdictFor(at.key, approval.read) !== "verified"
        ) {
          continue;
        }
        reached.set(String(approval.entry.subject), {
          key: subjectKey,
          name: approval.entry.subjectDisplayName,
          links: [
            ...at.links,
            {
              approver: approval.entry.origin.instanceId,
              sequence: approval.entry.origin.sequence,
              subject: approval.entry.subject,
              subjectDisplayName: approval.entry.subjectDisplayName,
              subjectDeviceKey: subjectKey,
            },
          ],
        });
        queue.push(String(approval.entry.subject));
      }
    }
    const atApprover = reached.get(String(approver));
    if (atApprover === undefined) continue;
    const approval = records.find(
      (record) =>
        record.entry.kind === "join-approved" &&
        String(record.entry.origin.instanceId) === String(approver) &&
        String(record.entry.subject) === String(local.instanceId) &&
        record.entry.subjectDeviceKey === local.publicKey &&
        verdictFor(atApprover.key, record.read) === "verified",
    );
    if (approval === undefined) continue;
    const admissions: ReplicaAdmissionRecord[] = [];
    const revocations: ReplicaRevocationRecord[] = [];
    for (const record of records) {
      const { entry } = record;
      const signer = reached.get(String(entry.origin.instanceId));
      if (signer === undefined || verdictFor(signer.key, record.read) !== "verified") continue;
      if (entry.kind === "revocation") {
        revocations.push({
          revoker: entry.origin.instanceId,
          revokerSequence: entry.origin.sequence,
          cut: { instanceId: entry.subject, lastAcceptedSequence: entry.lastAcceptedSequence ?? 0 },
        });
      } else if (
        entry.kind === "join-approved" &&
        entry.subjectDeviceKey !== undefined &&
        String(entry.subject) !== String(entry.origin.instanceId)
      ) {
        admissions.push({
          approver: entry.origin.instanceId,
          approverSequence: entry.origin.sequence,
          member: {
            instanceId: entry.subject,
            displayName: entry.subjectDisplayName,
            publicKey: entry.subjectDeviceKey,
          },
        });
      }
    }
    const derived = deriveReplicaMembership({
      roots: [founder],
      requests,
      admissions,
      revocations,
    });
    const admitsLocal =
      derived.members.some(
        (member) =>
          String(member.instanceId) === String(local.instanceId) &&
          member.publicKey === local.publicKey,
      ) && !derived.cuts.some((cut) => String(cut.instanceId) === String(local.instanceId));
    chains.push({
      admitsLocal,
      founder,
      approverDisplayName: atApprover.name,
      approverKey: atApprover.key,
      links: [
        ...atApprover.links,
        {
          approver,
          sequence: approval.entry.origin.sequence,
          subject: local.instanceId,
          subjectDisplayName: approval.entry.subjectDisplayName,
          subjectDeviceKey: local.publicKey,
        },
      ],
    });
  }
  return chains;
}

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
  return state.revocations.some((revoked) => String(revoked.instanceId) === String(instanceId));
}

/**
 * Whether a revoked computer other than `subject` holds this key: a new
 * identity carrying it is that computer back under another name. The revoked
 * computer's own records keep its key and are not refused for it.
 */
function keyBelongsToAnotherRevoked(
  state: ReplicaMembershipState,
  publicKey: string,
  subject: ReplicaInstanceId,
): boolean {
  return state.members.some(
    (member) =>
      member.publicKey === publicKey &&
      String(member.instanceId) !== String(subject) &&
      isRevoked(state, member.instanceId),
  );
}

/** This computer's identity was revoked, or was admitted and is no longer a member. */
function identityFinished(state: ReplicaMembershipState): boolean {
  const local = state.local;
  if (local === undefined) return false;
  if (isRevoked(state, local.instanceId)) return true;
  return state.localAdmitted && !isMember(state, local.instanceId);
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
