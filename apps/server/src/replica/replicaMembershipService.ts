/**
 * Commands a host person runs to manage who may write to a replica store.
 *
 * The service composes the pure membership policy, the device signing key,
 * and the write-once store. Every outcome - including refusals and store
 * failures - is journaled, because "why is that computer not a member" has
 * to stay answerable after the fact. A store failure never unwinds a local
 * decision, and no secret ever passes through the store: only public keys,
 * names, and signed records.
 */

import {
  REPLICA_ENTRY_FORMAT,
  decodeReplicaMembershipEntry,
  encodeReplicaEntry,
  replicaEntryRelativePaths,
  type ReplicaInstanceId,
  type ReplicaMembershipEntry,
} from "@octant/contracts/replica-entry";
import {
  buildReplicaJoinMatchingPreimage,
  decideReplicaJoinApproval,
  decideReplicaRevocation,
  replicaJoinRequestIsFresh,
  type ReplicaMembershipFacts,
} from "@octant/domain/replica-membership-policy";
import { createHash, randomUUID } from "node:crypto";
import type { ReplicaStore } from "@octant/plugin-api/replica-store";
import {
  verifyReplicaEntrySignature,
  type ReplicaDeviceSigningKey,
} from "./replicaDeviceKeyService";

export const REPLICA_MEMBERSHIP_AGGREGATE_TYPE = "replica-membership";
export const REPLICA_MEMBERSHIP_EVENT_NAMES = {
  replicaCreated: "replica.membership-created@1",
  joinRequested: "replica.join-requested@1",
  joinApproved: "replica.join-approved@1",
  joinApprovalRefused: "replica.join-approval-refused@1",
  revoked: "replica.membership-revoked@1",
  revocationRefused: "replica.membership-revocation-refused@1",
  storeFailure: "replica.membership-store-failure@1",
} as const;

export interface ReplicaMembershipJournalPort {
  readonly append: (input: {
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  }) => void;
}

export interface ReplicaMembershipPorts {
  /** The store this membership belongs to. */
  readonly store: ReplicaStore;
  /** Host credential store holding this instance's device signing key. */
  readonly credentials: {
    readonly ensure: (instanceId: string) => Promise<ReplicaDeviceSigningKey>;
    readonly sign: (
      instanceId: string,
      payload: Uint8Array,
    ) => Promise<{ readonly signature: string }>;
  };
  readonly journal: ReplicaMembershipJournalPort;
  /** Reads current membership facts. */
  readonly facts: () => ReplicaMembershipFacts;
  /** Next sequence for the local instance. */
  readonly nextSequence: () => number;
  readonly clock: () => number;
}

export type ReplicaMembershipCommand =
  | { readonly kind: "create-replica"; readonly displayName: string }
  | { readonly kind: "write-join-request"; readonly displayName: string }
  | {
      readonly kind: "approve-join";
      readonly joinRequest: ReplicaMembershipEntry;
      readonly confirmationCode: string;
    }
  | { readonly kind: "revoke"; readonly subject: ReplicaInstanceId };

export type ReplicaMembershipOutcome =
  | {
      readonly kind: "replica-created";
      readonly instanceId: ReplicaInstanceId;
      readonly entry: ReplicaMembershipEntry;
    }
  | {
      readonly kind: "join-requested";
      readonly instanceId: ReplicaInstanceId;
      readonly entry: ReplicaMembershipEntry;
    }
  | {
      readonly kind: "join-approved";
      readonly subject: ReplicaInstanceId;
      readonly entry: ReplicaMembershipEntry;
    }
  | {
      readonly kind: "revoked";
      readonly subject: ReplicaInstanceId;
      readonly entry: ReplicaMembershipEntry;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "already-member"
        | "revoked-instance"
        | "code-mismatch"
        | "expired-join-request"
        | "unknown-instance"
        | "not-a-member"
        | "store-unavailable"
        | "key-unavailable";
      readonly message: string;
    }
  | {
      readonly kind: "store-failed";
      readonly message: string;
    };

/**
 * Derive the six-digit matching code both screens show. The joining computer
 * computes it from its own join request and the approving computer's id; the
 * approver computes it from the request it read plus its own id.
 */
export function deriveReplicaJoinMatchingCode(input: {
  readonly joinRequest: ReplicaMembershipEntry;
  readonly approverInstanceId: ReplicaInstanceId;
}): string {
  const deviceKey = input.joinRequest.subjectDeviceKey;
  if (deviceKey === undefined) {
    throw new Error("A join request without a device key has no matching code.");
  }
  const preimage = buildReplicaJoinMatchingPreimage({
    joinRequest: {
      origin: {
        instanceId: input.joinRequest.origin.instanceId,
        displayName: input.joinRequest.origin.displayName,
      },
      subject: input.joinRequest.subject,
      publicKey: deviceKey,
    },
    approverInstanceId: input.approverInstanceId,
  });
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

export class ReplicaMembershipService {
  readonly #ports: ReplicaMembershipPorts;

  constructor(ports: ReplicaMembershipPorts) {
    this.#ports = ports;
  }

  async execute(command: ReplicaMembershipCommand): Promise<ReplicaMembershipOutcome> {
    switch (command.kind) {
      case "create-replica":
        return this.#createReplica(command.displayName);
      case "write-join-request":
        return this.#writeJoinRequest(command.displayName);
      case "approve-join":
        return this.#approveJoin(command.joinRequest, command.confirmationCode);
      case "revoke":
        return this.#revoke(command.subject);
    }
  }

  async #createReplica(displayName: string): Promise<ReplicaMembershipOutcome> {
    const instanceId = randomUUID() as ReplicaInstanceId;
    let key: ReplicaDeviceSigningKey;
    try {
      key = await this.#ports.credentials.ensure(instanceId);
    } catch {
      return this.#refuse("key-unavailable", "The device signing key could not be created.");
    }
    const sequence = this.#ports.nextSequence();
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-approved",
      origin: { instanceId, displayName, sequence },
      subject: instanceId,
      subjectDisplayName: displayName,
      subjectDeviceKey: key.publicKey,
    });
    const published = await this.#publish(instanceId, sequence, entry);
    if (published !== undefined) return published;
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.replicaCreated, instanceId, {
      kind: "replica-created",
      instanceId,
      displayName,
      publicKey: key.publicKey,
    });
    return { kind: "replica-created", instanceId, entry };
  }

  async #writeJoinRequest(displayName: string): Promise<ReplicaMembershipOutcome> {
    const facts = this.#ports.facts();
    const instanceId = facts.localInstanceId;
    if (facts.revocations.some((id) => String(id) === String(instanceId))) {
      return this.#refuse("revoked-instance", "This instance was revoked and cannot rejoin.");
    }
    let key: ReplicaDeviceSigningKey;
    try {
      key = await this.#ports.credentials.ensure(instanceId);
    } catch {
      return this.#refuse("key-unavailable", "The device signing key could not be created.");
    }
    const sequence = this.#ports.nextSequence();
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-request",
      origin: { instanceId, displayName, sequence },
      subject: instanceId,
      subjectDisplayName: displayName,
      subjectDeviceKey: key.publicKey,
      requestedAt: this.#ports.clock(),
    });
    const published = await this.#publish(instanceId, sequence, entry);
    if (published !== undefined) return published;
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinRequested, instanceId, {
      kind: "join-requested",
      instanceId,
      displayName,
      sequence,
    });
    return { kind: "join-requested", instanceId, entry };
  }

  async #approveJoin(
    joinRequest: ReplicaMembershipEntry,
    confirmationCode: string,
  ): Promise<ReplicaMembershipOutcome> {
    if (joinRequest.kind !== "join-request") {
      return this.#refuse("not-a-member", "Only a join request can be approved.");
    }
    const facts = this.#ports.facts();
    const deviceKey = joinRequest.subjectDeviceKey;
    const requestedAt = joinRequest.requestedAt;
    if (deviceKey === undefined || requestedAt === undefined) {
      return this.#refuse("not-a-member", "The join request carries no device key.");
    }
    // The caller's copy proves nothing: the matching code is derived from
    // these same fields, so a request that was never written to the store -
    // or was rewritten since - would still match its own code. Approval is
    // published only for the entry the store holds and the joiner signed.
    const paths = replicaEntryRelativePaths(
      joinRequest.origin.instanceId,
      joinRequest.origin.sequence,
    );
    const stored = await this.#ports.store.get(paths.entry);
    const storedSignature = await this.#ports.store.get(paths.signature);
    for (const read of [stored, storedSignature]) {
      if (read.status === "not-connected" || read.status === "refused") {
        this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure, joinRequest.subject, {
          kind: "store-failure",
          phase: "join-request-read",
          reason: read.status,
        });
        return this.#refuse("store-unavailable", "The replica store cannot be read.");
      }
    }
    if (stored.status !== "ready" || storedSignature.status !== "ready") {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinApprovalRefused, joinRequest.subject, {
        kind: "join-approval-refused",
        reason: "unknown-instance",
        subject: joinRequest.subject,
      });
      return this.#refuse(
        "unknown-instance",
        "No join request from that computer is in the store.",
      );
    }
    const payload = stored.bytes;
    if (
      new TextDecoder().decode(payload) !== encodeReplicaEntry(joinRequest) ||
      !verifyReplicaEntrySignature({
        publicKeyBase64: deviceKey,
        payload,
        signatureBase64: new TextDecoder().decode(storedSignature.bytes),
      })
    ) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinApprovalRefused, joinRequest.subject, {
        kind: "join-approval-refused",
        reason: "code-mismatch",
        subject: joinRequest.subject,
      });
      return this.#refuse("code-mismatch", "The stored join request does not verify.");
    }
    if (!replicaJoinRequestIsFresh(requestedAt, this.#ports.clock())) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinApprovalRefused, joinRequest.subject, {
        kind: "join-approval-refused",
        reason: "expired-join-request",
        subject: joinRequest.subject,
      });
      return this.#refuse("expired-join-request", "That join request is no longer fresh.");
    }
    const decision = decideReplicaJoinApproval({
      facts,
      joinRequest: {
        origin: {
          instanceId: joinRequest.origin.instanceId,
          displayName: joinRequest.origin.displayName,
        },
        subject: joinRequest.subject,
        publicKey: deviceKey,
      },
    });
    if (decision.status === "refused") {
      return this.#refuse(
        decision.reason,
        decision.reason === "already-member"
          ? "That computer is already a member."
          : "That identity was revoked and cannot rejoin.",
      );
    }
    const expected = deriveReplicaJoinMatchingCode({
      joinRequest,
      approverInstanceId: facts.localInstanceId,
    });
    if (confirmationCode !== expected) {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinApprovalRefused, joinRequest.subject, {
        kind: "join-approval-refused",
        reason: "code-mismatch",
        subject: joinRequest.subject,
      });
      return this.#refuse("code-mismatch", "The matching codes do not agree.");
    }
    const sequence = this.#ports.nextSequence();
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "join-approved",
      origin: {
        instanceId: facts.localInstanceId,
        displayName: "This PC",
        sequence,
      },
      subject: joinRequest.subject,
      subjectDisplayName: joinRequest.subjectDisplayName,
      subjectDeviceKey: deviceKey,
    });
    const published = await this.#publish(facts.localInstanceId, sequence, entry);
    if (published !== undefined) return published;
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.joinApproved, joinRequest.subject, {
      kind: "join-approved",
      subject: joinRequest.subject,
      subjectDisplayName: joinRequest.subjectDisplayName,
      subjectDeviceKey: deviceKey,
    });
    return { kind: "join-approved", subject: joinRequest.subject, entry };
  }

  async #revoke(subject: ReplicaInstanceId): Promise<ReplicaMembershipOutcome> {
    const facts = this.#ports.facts();
    const member = facts.members.find((m) => String(m.instanceId) === String(subject));
    const decision = decideReplicaRevocation(facts, subject);
    if (decision.status === "refused") {
      return this.#refuse(
        decision.reason,
        decision.reason === "unknown-instance"
          ? "No member has that id."
          : decision.reason === "not-a-member"
            ? "That computer is not a member."
            : "That identity is already revoked.",
      );
    }
    const sequence = this.#ports.nextSequence();
    const entry = decodeReplicaMembershipEntry({
      format: REPLICA_ENTRY_FORMAT,
      kind: "revocation",
      origin: {
        instanceId: facts.localInstanceId,
        displayName: "This PC",
        sequence,
      },
      subject,
      subjectDisplayName: member?.displayName ?? "Unknown",
    });
    const published = await this.#publish(facts.localInstanceId, sequence, entry);
    if (published !== undefined) return published;
    this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.revoked, subject, {
      kind: "revoked",
      subject,
    });
    return { kind: "revoked", subject, entry };
  }

  /**
   * Publish one entry and its detached signature. The signature goes in
   * first: a reader that finds an entry always finds its signature beside
   * it, and write-once storage can never add one later. Returns a refusal
   * outcome when the store cannot take it; never unwinds the local decision.
   */
  async #publish(
    instanceId: ReplicaInstanceId,
    sequence: number,
    entry: ReplicaMembershipEntry,
  ): Promise<ReplicaMembershipOutcome | undefined> {
    const paths = replicaEntryRelativePaths(instanceId, sequence);
    const encoded = encodeReplicaEntry(entry);
    let signature: string;
    try {
      const signed = await this.#ports.credentials.sign(
        instanceId,
        new TextEncoder().encode(encoded),
      );
      signature = signed.signature;
    } catch {
      return this.#refuse("key-unavailable", "The entry could not be signed.");
    }
    const signatureResult = await this.#ports.store.putIfAbsent(
      paths.signature,
      new TextEncoder().encode(signature),
    );
    if (signatureResult.status !== "stored") {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure, instanceId, {
        kind: "store-failure",
        phase: "signature",
        reason: signatureResult.status,
      });
      return { kind: "store-failed", message: "The replica store did not take the signature." };
    }
    const entryResult = await this.#ports.store.putIfAbsent(
      paths.entry,
      new TextEncoder().encode(encoded),
    );
    if (entryResult.status !== "stored") {
      this.#journal(REPLICA_MEMBERSHIP_EVENT_NAMES.storeFailure, instanceId, {
        kind: "store-failure",
        phase: "entry",
        reason: entryResult.status,
      });
      return { kind: "store-failed", message: "The replica store did not take the entry." };
    }
    return undefined;
  }

  #journal(eventName: string, aggregateId: string, payload: unknown): void {
    this.#ports.journal.append({
      aggregateType: REPLICA_MEMBERSHIP_AGGREGATE_TYPE,
      aggregateId,
      eventName,
      payload,
    });
  }

  #refuse(
    reason: Extract<ReplicaMembershipOutcome, { kind: "refused" }>["reason"],
    message: string,
  ): ReplicaMembershipOutcome {
    return { kind: "refused", reason, message };
  }
}
