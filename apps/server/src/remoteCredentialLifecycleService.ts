import { createHash, verify } from "node:crypto";
import { REMOTE_ACCESS_EVENT_NAMES, type StableHostId } from "@octant/contracts/remote-access";
import {
  decodeRemoteOwnDeviceMetadataV1,
  type RemoteOwnDeviceMetadataV1,
} from "@octant/contracts/remote-request-proof";
import { buildRemoteKeyRotationProofPayload } from "@octant/domain";
import { evaluateCredentialUse } from "@octant/domain/remote-credential-policy";
import {
  canonicalDeviceKeyFacts,
  deviceKeyFingerprintMatches,
  type CanonicalDeviceKeyFacts,
} from "./remote/deviceKeyFacts";
import type { Journal } from "./persistence/journal";
import {
  readDeviceRegistration,
  readDeviceRegistrations,
  readHostIdentity,
  readRemoteCommandReceipt,
  type DeviceRegistrationProjectionRow,
} from "./persistence/remoteAccessProjection";
import type { SqliteConnection } from "./persistence/sqlitePort";

const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
// S4: Bounded batch size for all-session invalidation. Each journal append
// processes at most this many sessions, ensuring bounded rows/events/UUIDs
// per transaction. Crash/retry semantics: if a crash occurs mid-batch, the
// retry finds the receipt already committed and re-cancels remaining active
// sessions in subsequent batches.
const SESSION_INVALIDATION_BATCH_SIZE = 256;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type RemoteCredentialLifecycleErrorCategory = "invalid" | "not-found" | "conflict";

export class RemoteCredentialLifecycleError extends Error {
  override readonly name = "RemoteCredentialLifecycleError";

  constructor(
    readonly category: RemoteCredentialLifecycleErrorCategory,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionInvalidationNotification {
  readonly hostId: string;
  readonly deviceIds: readonly string[];
  readonly sessionIdDigests: readonly string[];
  readonly reasonCode: string;
}

export interface SessionCancellationOutcome {
  readonly canceled: number;
  readonly cancelHookFailures: number;
}

export interface RemoteCredentialLifecycleServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly actorId: string;
  readonly uuid: () => string;
  readonly clock: () => string;
  /**
   * Invoked only after durable session invalidation commits. Callers cancel
   * matching active requests/streams synchronously before returning to clients.
   * Returns a truthful cancellation outcome so the receipt can distinguish
   * "canceled" from "canceled but a hook failed".
   */
  readonly onSessionsInvalidated?: (
    input: SessionInvalidationNotification,
  ) => SessionCancellationOutcome;
}

export interface RemoteCredentialOperationReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
  readonly cancellation?: SessionCancellationOutcome;
}

export class RemoteCredentialLifecycleService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #actorId: string;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #onSessionsInvalidated:
    | ((input: SessionInvalidationNotification) => SessionCancellationOutcome)
    | undefined;

  constructor(options: RemoteCredentialLifecycleServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#actorId = options.actorId;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#onSessionsInvalidated = options.onSessionsInvalidated;
  }

  rotateDevice(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly newDeviceKeyFingerprint: string;
    readonly newDevicePublicKey: string;
  }): RemoteCredentialOperationReceipt {
    validateDeviceKeyFingerprint(input.newDeviceKeyFingerprint);
    const keyFacts = requireCanonicalDeviceKey(
      input.newDeviceKeyFingerprint,
      input.newDevicePublicKey,
    );
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      deviceId: input.deviceId,
      reasonCode: "credential-rotated",
      operationKind: "rotate-device",
      operationDigest: digestOperation({
        deviceId: input.deviceId,
        newDeviceKeyFingerprint: input.newDeviceKeyFingerprint,
        newDevicePublicKey: keyFacts.canonicalPem,
      }),
      buildEvents: (now, device) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceKeyRotated,
          payload: {
            hostId: input.hostId,
            deviceId: input.deviceId,
            previousGeneration: device.credential_generation,
            credentialGeneration: device.credential_generation + 1,
            deviceKeyFingerprint: input.newDeviceKeyFingerprint,
            devicePublicKey: keyFacts.canonicalPem,
            rotatedAt: now,
            graceExpiresAt: now,
          },
        },
      ],
    });
  }

  rotateAll(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly devices: ReadonlyArray<{
      readonly deviceId: string;
      readonly newDeviceKeyFingerprint: string;
      readonly newDevicePublicKey: string;
    }>;
  }): RemoteCredentialOperationReceipt {
    if (input.devices.length > 256) {
      throw new RemoteCredentialLifecycleError("invalid", "Credential operation is too large.");
    }
    assertUniqueDeviceRequests(input.devices);
    const requested = new Map(input.devices.map((device) => [device.deviceId, device]));
    const canonicalKeys = new Map<string, CanonicalDeviceKeyFacts>();
    for (const device of input.devices) {
      validateDeviceKeyFingerprint(device.newDeviceKeyFingerprint);
      canonicalKeys.set(
        device.deviceId,
        requireCanonicalDeviceKey(device.newDeviceKeyFingerprint, device.newDevicePublicKey),
      );
    }
    const devices = readDeviceRegistrations(this.#connection)
      .filter(
        (device) =>
          device.host_id === input.hostId &&
          device.state === "active" &&
          requested.has(device.device_id),
      )
      .sort((left, right) => String(left.device_id).localeCompare(String(right.device_id)));
    if (devices.length !== requested.size) {
      throw new RemoteCredentialLifecycleError("not-found", "Device is unavailable.");
    }
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      reasonCode: "credentials-rotated-all",
      operationKind: "rotate-all",
      operationDigest: digestOperation(
        input.devices.map((device) => ({
          deviceId: device.deviceId,
          newDeviceKeyFingerprint: device.newDeviceKeyFingerprint,
          newDevicePublicKey: canonicalKeys.get(device.deviceId)!.canonicalPem,
        })),
      ),
      devices,
      buildEvents: (now, device) => {
        const requestedDevice = requested.get(device.device_id);
        const canonicalKey = canonicalKeys.get(device.device_id);
        if (requestedDevice === undefined || canonicalKey === undefined) {
          throw new RemoteCredentialLifecycleError("not-found", "Device is unavailable.");
        }
        return [
          {
            eventName: REMOTE_ACCESS_EVENT_NAMES.deviceKeyRotated,
            payload: {
              hostId: input.hostId,
              deviceId: device.device_id,
              previousGeneration: device.credential_generation,
              credentialGeneration: device.credential_generation + 1,
              deviceKeyFingerprint: requestedDevice.newDeviceKeyFingerprint,
              devicePublicKey: canonicalKey.canonicalPem,
              rotatedAt: now,
              graceExpiresAt: now,
            },
          },
        ];
      },
    });
  }

  revokeDevice(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly reasonCode?: string;
  }): RemoteCredentialOperationReceipt {
    const reasonCode = input.reasonCode ?? "device-revoked";
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      deviceId: input.deviceId,
      reasonCode,
      operationKind: "revoke-device",
      operationDigest: digestOperation({
        deviceId: input.deviceId,
        reasonCode,
      }),
      buildEvents: (now, device) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRevoked,
          payload: {
            hostId: input.hostId,
            deviceId: input.deviceId,
            credentialGeneration: device.credential_generation + 1,
            revokedAt: now,
            reasonCode,
          },
        },
      ],
    });
  }

  revokeAll(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly reasonCode?: string;
  }): RemoteCredentialOperationReceipt {
    const reasonCode = input.reasonCode ?? "all-devices-revoked";
    const devices = readDeviceRegistrations(this.#connection)
      .filter((device) => device.host_id === input.hostId && device.state === "active")
      .sort((left, right) => String(left.device_id).localeCompare(String(right.device_id)));
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      reasonCode,
      operationKind: "revoke-all",
      operationDigest: digestOperation({
        reasonCode,
      }),
      devices,
      buildEvents: (now, device) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRevoked,
          payload: {
            hostId: input.hostId,
            deviceId: device.device_id,
            credentialGeneration: device.credential_generation + 1,
            revokedAt: now,
            reasonCode,
          },
        },
      ],
    });
  }

  reconcileExpired(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
  }): RemoteCredentialOperationReceipt {
    const nowMs = Date.parse(this.#clock());
    const devices = readDeviceRegistrations(this.#connection).filter(
      (device) =>
        device.host_id === input.hostId &&
        device.state === "active" &&
        Number.isFinite(Date.parse(device.expires_at)) &&
        Date.parse(device.expires_at) <= nowMs,
    );
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      reasonCode: "credential-expired",
      operationKind: "reconcile-expired",
      operationDigest: digestOperation({}),
      devices,
      buildEvents: (now, device) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceCredentialExpired,
          payload: {
            hostId: input.hostId,
            deviceId: device.device_id,
            credentialGeneration: device.credential_generation,
            expiredAt: now,
            reasonCode: "credential-expired",
          },
        },
      ],
    });
  }

  recoverHostKey(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly newHostKeyFingerprint: string;
    readonly newKeyGeneration: number;
  }): RemoteCredentialOperationReceipt {
    validateDeviceKeyFingerprint(input.newHostKeyFingerprint);
    const host = readHostIdentity(this.#connection);
    if (host === undefined || host.host_id !== input.hostId) {
      throw new RemoteCredentialLifecycleError("not-found", "Host identity is unavailable.");
    }
    if (
      input.newKeyGeneration !== host.key_generation + 1 ||
      input.newHostKeyFingerprint === host.key_fingerprint
    ) {
      throw new RemoteCredentialLifecycleError("conflict", "Host identity recovery is stale.");
    }
    const devices = readDeviceRegistrations(this.#connection).filter(
      (device) => device.host_id === input.hostId && device.state !== "revoked",
    );
    return this.#mutate({
      commandId: input.commandId,
      hostId: input.hostId,
      reasonCode: "host-key-recovered",
      operationKind: "recover-host-key",
      operationDigest: digestOperation({
        newHostKeyFingerprint: input.newHostKeyFingerprint,
        newKeyGeneration: input.newKeyGeneration,
      }),
      devices,
      prefixEvents: (now) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.hostKeyRotated,
          payload: {
            hostId: input.hostId,
            previousKeyGeneration: host.key_generation,
            keyGeneration: input.newKeyGeneration,
            hostKeyFingerprint: input.newHostKeyFingerprint,
            rotatedAt: now,
          },
        },
      ],
      buildEvents: (now, device) => [
        {
          eventName: REMOTE_ACCESS_EVENT_NAMES.deviceRevoked,
          payload: {
            hostId: input.hostId,
            deviceId: device.device_id,
            credentialGeneration: device.credential_generation + 1,
            revokedAt: now,
            reasonCode: "host-key-recovered",
          },
        },
      ],
    });
  }

  /**
   * Authenticated self-rotation. Caller must have proven old-key possession via
   * the request proof; this method requires new-key possession over the canonical
   * rotation transcript before the generation advances atomically.
   */
  selfRotateDevice(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly credentialGeneration: number;
    readonly newDeviceKeyFingerprint: string;
    readonly newDevicePublicKey: string;
    readonly newKeyProof: string;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.deviceId, "device");
    validateDeviceKeyFingerprint(input.newDeviceKeyFingerprint);
    const keyFacts = requireCanonicalDeviceKey(
      input.newDeviceKeyFingerprint,
      input.newDevicePublicKey,
    );
    const device = this.#requiredDevice(input.hostId, input.deviceId);
    if (device.credential_generation !== input.credentialGeneration) {
      throw new RemoteCredentialLifecycleError("conflict", "Device credential is unavailable.");
    }
    if (
      !verifyNewKeyRotationProof({
        hostId: input.hostId,
        deviceId: input.deviceId,
        credentialGeneration: input.credentialGeneration,
        newDeviceKeyFingerprint: input.newDeviceKeyFingerprint,
        newDevicePublicKey: keyFacts.canonicalPem,
        newKeyProof: input.newKeyProof,
      })
    ) {
      throw new RemoteCredentialLifecycleError("invalid", "New device key proof is invalid.");
    }
    return this.rotateDevice({
      commandId: input.commandId,
      hostId: input.hostId,
      deviceId: input.deviceId,
      newDeviceKeyFingerprint: input.newDeviceKeyFingerprint,
      newDevicePublicKey: keyFacts.canonicalPem,
    });
  }

  /** Bounded own-device metadata for the authenticated principal only. */
  readOwnDeviceMetadata(input: {
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly credentialGeneration: number;
    readonly sessionIdleExpiresAt?: string;
    readonly sessionAbsoluteExpiresAt?: string;
  }): RemoteOwnDeviceMetadataV1 {
    assertUuid(input.deviceId, "device");
    const device = readDeviceRegistration(this.#connection, input.deviceId);
    if (device === undefined || device.hostId !== input.hostId) {
      throw new RemoteCredentialLifecycleError("not-found", "Device is unavailable.");
    }
    if (device.credentialGeneration !== input.credentialGeneration) {
      throw new RemoteCredentialLifecycleError(
        "not-found",
        "Device credential generation is stale.",
      );
    }
    return decodeRemoteOwnDeviceMetadataV1({
      deviceId: device.deviceId,
      deviceLabel: device.deviceLabel,
      origin: device.origin,
      credentialGeneration: device.credentialGeneration,
      createdAt: device.createdAt,
      expiresAt: device.expiresAt,
      lastSeenAt: device.lastSeenAt,
      state: device.state,
      ...(input.sessionIdleExpiresAt === undefined
        ? {}
        : { sessionIdleExpiresAt: input.sessionIdleExpiresAt }),
      ...(input.sessionAbsoluteExpiresAt === undefined
        ? {}
        : { sessionAbsoluteExpiresAt: input.sessionAbsoluteExpiresAt }),
    });
  }

  /** Authenticated self-revoke. Device identity must come from the principal only. */
  selfRevokeDevice(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.deviceId, "device");
    return this.revokeDevice({
      commandId: input.commandId,
      hostId: input.hostId,
      deviceId: input.deviceId,
      reasonCode: "self-revoked",
    });
  }

  /**
   * Invalidates only the cookie-backed session digest for the authenticated device.
   * Does not revoke the durable device registration.
   */
  signOut(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly sessionIdDigest: string;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.commandId, "command");
    assertUuid(input.deviceId, "device");
    validateDeviceKeyFingerprint(input.sessionIdDigest);
    return this.#sessionScopeMutate({
      commandId: input.commandId,
      hostId: input.hostId,
      deviceId: input.deviceId,
      reasonCode: "signed-out",
      operationKind: "sign-out",
      operationDigest: digestOperation({
        deviceId: input.deviceId,
        sessionIdDigest: input.sessionIdDigest,
      }),
      selectSessions: (connection) => {
        const row = connection
          .prepare(
            `SELECT session_id_digest, device_id, credential_generation
             FROM remote_session_store
             WHERE session_id_digest = ? AND host_id = ? AND device_id = ? AND state = 'active'`,
          )
          .get(input.sessionIdDigest, input.hostId, input.deviceId) as
          | {
              readonly session_id_digest: string;
              readonly device_id: string;
              readonly credential_generation: number;
            }
          | undefined;
        if (row === undefined) {
          throw new RemoteCredentialLifecycleError("not-found", "Session is unavailable.");
        }
        return [row];
      },
    });
  }

  /**
   * Restart/listener-disable invalidation: every active session for the host is
   * revoked while durable device registrations remain usable for fresh challenges.
   *
   * B1+B2+B3: Sessions are invalidated in deterministic bounded batches of
   * SESSION_INVALIDATION_BATCH_SIZE. Each batch selects, updates, and emits
   * events inside a single journal append transaction (`beforeEvents`), so the
   * mutation and events are atomic — if the append fails, no rows are revoked
   * and no events are emitted. The receipt is recorded as `"pending"` before
   * the first batch and updated to `"applied"` after the last batch completes.
   * A crash after the pending receipt but before completion leaves a durable
   * pending receipt with active sessions; retry resumes from remaining active
   * sessions and marks the receipt applied. Per-batch notification targets,
   * events, UUIDs, and memory are bounded; only counts are aggregated for the
   * final receipt.
   */
  invalidateAllSessions(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly reasonCode: string;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.commandId, "command");
    assertRedactedCode(input.reasonCode, "reason");
    const operationDigest = digestOperation({ reasonCode: input.reasonCode });
    validateOperationDigest(operationDigest);
    this.#cleanupReceipts();
    const existing = readRemoteCommandReceipt(this.#connection, input.commandId);
    if (existing !== undefined) {
      if (
        existing.host_id !== input.hostId ||
        existing.operation_kind !== "invalidate-all-sessions" ||
        existing.operation_digest !== operationDigest
      ) {
        throw new RemoteCredentialLifecycleError("conflict", "Command identity was reused.");
      }
      const existingResult = String(existing.result_category);
      if (existingResult === "applied") {
        // B2: Operation already completed — re-cancel any retained registry
        // entries for the original scope.
        const cancellation = this.#notifyInvalidation({
          hostId: input.hostId,
          deviceIds: [],
          sessionIdDigests: [],
          reasonCode: input.reasonCode,
        });
        return {
          commandId: input.commandId,
          result: "already-applied",
          occurredAt: String(existing.created_at),
          cancellation,
        };
      }
      // B2: Receipt is "pending" — resume the operation. Process remaining
      // active sessions in bounded batches, then mark applied.
      const now = this.#clock();
      const totalCounts = this.#invalidateAllSessionsBatched({
        hostId: input.hostId,
        reasonCode: input.reasonCode,
        receiptId: input.commandId,
        now,
      });
      this.#emitFinalAppliedReceipt({
        hostId: input.hostId,
        reasonCode: input.reasonCode,
        receiptId: input.commandId,
        operationDigest,
        now,
      });
      return {
        commandId: input.commandId,
        result: "applied",
        occurredAt: now,
        cancellation: totalCounts,
      };
    }

    // B2: Emit pending receipt + audit before any session batch.
    const now = this.#clock();
    this.#emitPendingReceipt({
      hostId: input.hostId,
      reasonCode: input.reasonCode,
      receiptId: input.commandId,
      operationDigest,
      now,
    });

    // B1+B3: Process sessions in bounded LIMIT pages.
    const totalCounts = this.#invalidateAllSessionsBatched({
      hostId: input.hostId,
      reasonCode: input.reasonCode,
      receiptId: input.commandId,
      now,
    });

    // B2: Emit final applied receipt.
    this.#emitFinalAppliedReceipt({
      hostId: input.hostId,
      reasonCode: input.reasonCode,
      receiptId: input.commandId,
      operationDigest,
      now,
    });
    return {
      commandId: input.commandId,
      result: "applied",
      occurredAt: now,
      cancellation: totalCounts,
    };
  }

  /**
   * B2: Emits the pending receipt and audit event before any session batch.
   * A crash after this append leaves a durable pending receipt with active
   * sessions; retry resumes.
   */
  #emitPendingReceipt(input: {
    readonly hostId: StableHostId;
    readonly reasonCode: string;
    readonly receiptId: string;
    readonly operationDigest: string;
    readonly now: string;
  }): void {
    const head = this.#connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get("remote-host", input.hostId) as { aggregate_version: number } | undefined;
    this.#journal.append(
      {
        aggregate: { aggregateType: "remote-host", aggregateId: input.hostId },
        expectedVersion: head?.aggregate_version ?? 0,
        events: [
          {
            eventId: this.#nextUuid(),
            eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
            eventVersion: 1,
            correlationId: input.receiptId,
            actor: { kind: "system", actorId: this.#actorId },
            occurredAt: input.now,
            payload: {
              record: {
                eventKind: "credential-lifecycle",
                hostId: input.hostId,
                protocolVersion: 1,
                credentialGeneration: 1,
                sourceClass: "loopback",
                resultCategory: "pending",
                reasonCode: input.reasonCode,
                correlationId: input.receiptId,
                occurredAt: input.now,
              },
            },
          },
          {
            eventId: this.#nextUuid(),
            eventName: REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
            eventVersion: 1,
            correlationId: input.receiptId,
            actor: { kind: "system", actorId: this.#actorId },
            occurredAt: input.now,
            payload: {
              commandId: input.receiptId,
              hostId: input.hostId,
              operationKind: "invalidate-all-sessions",
              operationDigest: input.operationDigest,
              resultCategory: "pending",
              createdAt: input.now,
              expiresAt: new Date(Date.parse(input.now) + RECEIPT_RETENTION_MS).toISOString(),
            },
          },
        ],
      },
      {},
    );
  }

  /**
   * B2: Emits the final applied receipt and audit event after all batches
   * complete. The projection's ON CONFLICT DO UPDATE updates result_category
   * from "pending" to "applied".
   */
  #emitFinalAppliedReceipt(input: {
    readonly hostId: StableHostId;
    readonly reasonCode: string;
    readonly receiptId: string;
    readonly operationDigest: string;
    readonly now: string;
  }): void {
    const head = this.#connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get("remote-host", input.hostId) as { aggregate_version: number } | undefined;
    this.#journal.append(
      {
        aggregate: { aggregateType: "remote-host", aggregateId: input.hostId },
        expectedVersion: head?.aggregate_version ?? 0,
        events: [
          {
            eventId: this.#nextUuid(),
            eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
            eventVersion: 1,
            correlationId: input.receiptId,
            actor: { kind: "system", actorId: this.#actorId },
            occurredAt: input.now,
            payload: {
              record: {
                eventKind: "credential-lifecycle",
                hostId: input.hostId,
                protocolVersion: 1,
                credentialGeneration: 1,
                sourceClass: "loopback",
                resultCategory: "applied",
                reasonCode: input.reasonCode,
                correlationId: input.receiptId,
                occurredAt: input.now,
              },
            },
          },
          {
            eventId: this.#nextUuid(),
            eventName: REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
            eventVersion: 1,
            correlationId: input.receiptId,
            actor: { kind: "system", actorId: this.#actorId },
            occurredAt: input.now,
            payload: {
              commandId: input.receiptId,
              hostId: input.hostId,
              operationKind: "invalidate-all-sessions",
              operationDigest: input.operationDigest,
              resultCategory: "applied",
              createdAt: input.now,
              expiresAt: new Date(Date.parse(input.now) + RECEIPT_RETENTION_MS).toISOString(),
            },
          },
        ],
      },
      {},
    );
  }

  /**
   * B1+B3: Invalidates all active sessions in bounded LIMIT pages. Each page
   * is a separate journal append. The `sessionInvalidated` events are
   * generated from the SELECT (outside the transaction) and passed as the
   * `events` array. The `beforeEvents` callback does the UPDATE inside the
   * transaction, validating that each session is still active — if an UPDATE
   * fails (concurrent invalidation), it throws to abort the transaction,
   * rolling back both the UPDATEs and the events. Per-batch notification
   * targets, events, UUIDs, and memory are bounded. Only counts are
   * aggregated.
   */
  #invalidateAllSessionsBatched(input: {
    readonly hostId: StableHostId;
    readonly reasonCode: string;
    readonly receiptId: string;
    readonly now: string;
  }): SessionCancellationOutcome {
    let totalCanceled = 0;
    let totalCancelHookFailures = 0;
    for (;;) {
      // B3: Select a bounded page of active sessions.
      const batch = this.#connection
        .prepare(
          `SELECT session_id_digest, device_id, credential_generation
           FROM remote_session_store
           WHERE host_id = ? AND state = 'active'
           ORDER BY session_id_digest
           LIMIT ?`,
        )
        .all(input.hostId, SESSION_INVALIDATION_BATCH_SIZE) as ReadonlyArray<{
        readonly session_id_digest: string;
        readonly device_id: string;
        readonly credential_generation: number;
      }>;
      if (batch.length === 0) break;

      // B1: Generate events from the SELECT. These events are passed as the
      // `events` array. The `beforeEvents` callback does the UPDATE inside
      // the transaction — if an UPDATE fails, it throws to abort, rolling
      // back both the UPDATEs and the events (atomic).
      const batchEvents = batch.map((session) => ({
        eventId: this.#nextUuid(),
        eventName: REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated,
        eventVersion: 1 as const,
        correlationId: input.receiptId,
        actor: { kind: "system" as const, actorId: this.#actorId },
        occurredAt: input.now,
        payload: {
          hostId: input.hostId,
          deviceId: session.device_id,
          sessionIdDigest: session.session_id_digest,
          credentialGeneration: session.credential_generation,
          invalidatedAt: input.now,
          reasonCode: input.reasonCode,
          receiptId: input.receiptId,
        },
      }));
      const batchDigests = batch.map((s) => s.session_id_digest);
      const batchDeviceIds = [...new Set(batch.map((s) => String(s.device_id)))];

      const head = this.#connection
        .prepare(
          "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
        )
        .get("remote-host", input.hostId) as { aggregate_version: number } | undefined;
      this.#journal.append(
        {
          aggregate: { aggregateType: "remote-host", aggregateId: input.hostId },
          expectedVersion: head?.aggregate_version ?? 0,
          events: batchEvents,
        },
        {
          beforeEvents: (connection) => {
            // B1: UPDATE inside the transaction. If any UPDATE fails (concurrent
            // invalidation), throw to abort the entire transaction — both the
            // UPDATEs and the events roll back atomically.
            const invalidate = connection.prepare(
              `UPDATE remote_session_store
               SET state = 'revoked'
               WHERE session_id_digest = ? AND host_id = ? AND device_id = ?
                 AND credential_generation = ? AND state = 'active'`,
            );
            for (const session of batch) {
              if (
                invalidate.run(
                  session.session_id_digest,
                  input.hostId,
                  session.device_id,
                  session.credential_generation,
                ).changes !== 1
              ) {
                throw new RemoteCredentialLifecycleError(
                  "conflict",
                  "Session state changed concurrently during batch invalidation.",
                );
              }
            }
            return [];
          },
        },
      );

      // B3: Per-batch notification with bounded targets.
      const batchCancellation = this.#notifyInvalidation({
        hostId: input.hostId,
        deviceIds: batchDeviceIds,
        sessionIdDigests: batchDigests,
        reasonCode: input.reasonCode,
      });
      totalCanceled += batchCancellation.canceled;
      totalCancelHookFailures += batchCancellation.cancelHookFailures;
    }
    return { canceled: totalCanceled, cancelHookFailures: totalCancelHookFailures };
  }

  isDeviceGenerationUsable(input: {
    readonly hostId: StableHostId;
    readonly deviceId: string;
    readonly presentedGeneration: number;
    readonly now?: number;
  }): ReturnType<typeof evaluateCredentialUse> {
    const device = readDeviceRegistration(this.#connection, input.deviceId);
    if (device === undefined || device.host_id !== input.hostId) {
      return { kind: "rejected", reason: "revoked" };
    }
    return evaluateCredentialUse({
      deviceState: device.state,
      credentialGeneration: device.credential_generation,
      presentedGeneration: input.presentedGeneration,
      expiresAt: Date.parse(device.expires_at),
      now: input.now ?? Date.parse(this.#clock()),
    });
  }

  #mutate(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId?: string;
    readonly reasonCode: string;
    readonly operationKind: string;
    readonly operationDigest: string;
    readonly devices?: ReadonlyArray<DeviceRegistrationProjectionRow>;
    readonly prefixEvents?: (
      now: string,
    ) => ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>;
    readonly buildEvents: (
      now: string,
      device: DeviceRegistrationProjectionRow,
    ) => ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.commandId, "command");
    assertRedactedCode(input.reasonCode, "reason");
    assertRedactedCode(input.operationKind, "operation");
    validateOperationDigest(input.operationDigest);
    this.#cleanupReceipts();
    const existing = readRemoteCommandReceipt(this.#connection, input.commandId);
    if (existing !== undefined) {
      if (
        existing.host_id !== input.hostId ||
        String(existing.device_id ?? "") !== String(input.deviceId ?? "") ||
        existing.operation_kind !== input.operationKind ||
        existing.operation_digest !== input.operationDigest
      ) {
        throw new RemoteCredentialLifecycleError("conflict", "Command identity was reused.");
      }
      // S2: Retry/lost-response recovery: re-attempt cancellation for the
      // original operation scope. The durable receipt is already committed,
      // but active work may have survived a lost response or a failed cancel
      // hook. The registry retains failed entries by device, so retrying by
      // device ID re-invokes the same retained hooks even if the sessions
      // are already revoked. The cancellation outcome is truthful.
      const retryDeviceIds =
        input.devices?.map((d) => String(d.device_id)) ??
        (input.deviceId !== undefined ? [input.deviceId] : []);
      const retrySessions = retryDeviceIds.flatMap((deviceId) =>
        this.#selectActiveSessionsForCancellation(input.hostId, deviceId),
      );
      const retryNotification: SessionInvalidationNotification = {
        hostId: input.hostId,
        // S2: Always include the original device IDs even if no active sessions
        // remain — the registry retries retained failed hooks by device.
        deviceIds: retryDeviceIds,
        sessionIdDigests: retrySessions.map((s) => s.session_id_digest),
        reasonCode: input.reasonCode,
      };
      const cancellation = this.#notifyInvalidation(retryNotification);
      return {
        commandId: input.commandId,
        result: "already-applied",
        occurredAt: String(existing.created_at),
        cancellation,
      };
    }

    const devices = input.devices ?? [this.#requiredDevice(input.hostId, input.deviceId)];
    if (devices.length > 256) {
      throw new RemoteCredentialLifecycleError("invalid", "Credential operation is too large.");
    }
    const now = this.#clock();
    const events = [
      ...(input.prefixEvents?.(now) ?? []),
      ...devices.flatMap((device) => input.buildEvents(now, device)),
    ];
    events.push({
      eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
      payload: {
        record: {
          eventKind: "credential-lifecycle",
          hostId: input.hostId,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          protocolVersion: 1,
          credentialGeneration: Number(devices[0]?.credential_generation ?? 1),
          sourceClass: "loopback",
          resultCategory: "applied",
          reasonCode: input.reasonCode,
          correlationId: input.commandId,
          occurredAt: now,
        },
      },
    });
    events.push({
      eventName: REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
      payload: {
        commandId: input.commandId,
        hostId: input.hostId,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        operationKind: input.operationKind,
        operationDigest: input.operationDigest,
        resultCategory: "applied",
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + RECEIPT_RETENTION_MS).toISOString(),
      },
    });

    const aggregateId = input.hostId;
    const head = this.#connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get("remote-host", aggregateId) as { aggregate_version: number } | undefined;
    const eventInputs = events.map((event) => ({
      eventId: this.#nextUuid(),
      eventName: event.eventName,
      eventVersion: 1,
      correlationId: input.commandId,
      actor: { kind: "system" as const, actorId: this.#actorId },
      occurredAt: now,
      payload: event.payload,
    }));
    let notification: SessionInvalidationNotification | undefined;
    this.#journal.append(
      {
        aggregate: { aggregateType: "remote-host", aggregateId },
        expectedVersion: head?.aggregate_version ?? 0,
        events: eventInputs,
      },
      {
        beforeEvents: (connection) => {
          const invalidated = this.#invalidateAuthoritativeSessions({
            connection,
            devices,
            hostId: input.hostId,
            reasonCode: input.reasonCode,
            receiptId: input.commandId,
            now,
          });
          notification = {
            hostId: input.hostId,
            deviceIds: [...new Set(devices.map((device) => String(device.device_id)))],
            sessionIdDigests: invalidated.sessionIdDigests,
            reasonCode: input.reasonCode,
          };
          return invalidated.events;
        },
      },
    );
    if (notification !== undefined) {
      const cancellation = this.#notifyInvalidation(notification);
      return { commandId: input.commandId, result: "applied", occurredAt: now, cancellation };
    }
    return { commandId: input.commandId, result: "applied", occurredAt: now };
  }

  #sessionScopeMutate(input: {
    readonly commandId: string;
    readonly hostId: StableHostId;
    readonly deviceId?: string;
    readonly reasonCode: string;
    readonly operationKind: string;
    readonly operationDigest: string;
    readonly selectSessions: (connection: SqliteConnection) => ReadonlyArray<{
      readonly session_id_digest: string;
      readonly device_id: string;
      readonly credential_generation: number;
    }>;
  }): RemoteCredentialOperationReceipt {
    assertUuid(input.commandId, "command");
    assertRedactedCode(input.reasonCode, "reason");
    assertRedactedCode(input.operationKind, "operation");
    validateOperationDigest(input.operationDigest);
    this.#cleanupReceipts();
    const existing = readRemoteCommandReceipt(this.#connection, input.commandId);
    if (existing !== undefined) {
      if (
        existing.host_id !== input.hostId ||
        String(existing.device_id ?? "") !== String(input.deviceId ?? "") ||
        existing.operation_kind !== input.operationKind ||
        existing.operation_digest !== input.operationDigest
      ) {
        throw new RemoteCredentialLifecycleError("conflict", "Command identity was reused.");
      }
      // S2: Retry/lost-response recovery: re-attempt cancellation for the
      // original operation scope. The durable receipt is already committed,
      // but active work may have survived a lost response or a failed cancel
      // hook. The registry retains failed entries by device/session, so
      // retrying by device ID re-invokes the same retained hooks even if the
      // sessions are already revoked. The cancellation outcome is truthful.
      const retrySessions = this.#selectActiveSessionsForCancellation(input.hostId, input.deviceId);
      const retryNotification: SessionInvalidationNotification = {
        hostId: input.hostId,
        // S2: Always include the original device ID even if no active sessions
        // remain — the registry retries retained failed hooks by device.
        deviceIds: input.deviceId !== undefined ? [input.deviceId] : [],
        sessionIdDigests: retrySessions.map((s) => s.session_id_digest),
        reasonCode: input.reasonCode,
      };
      const cancellation = this.#notifyInvalidation(retryNotification);
      return {
        commandId: input.commandId,
        result: "already-applied",
        occurredAt: String(existing.created_at),
        cancellation,
      };
    }

    const now = this.#clock();
    const sessions = input.selectSessions(this.#connection);
    const credentialGeneration = Number(sessions[0]?.credential_generation ?? 1);
    const events = [
      {
        eventName: REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded,
        payload: {
          record: {
            eventKind: "credential-lifecycle",
            hostId: input.hostId,
            ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
            protocolVersion: 1,
            credentialGeneration,
            sourceClass: "loopback",
            resultCategory: "applied",
            reasonCode: input.reasonCode,
            correlationId: input.commandId,
            occurredAt: now,
          },
        },
      },
      {
        eventName: REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded,
        payload: {
          commandId: input.commandId,
          hostId: input.hostId,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          operationKind: input.operationKind,
          operationDigest: input.operationDigest,
          resultCategory: "applied",
          createdAt: now,
          expiresAt: new Date(Date.parse(now) + RECEIPT_RETENTION_MS).toISOString(),
        },
      },
    ];
    const head = this.#connection
      .prepare(
        "SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
      )
      .get("remote-host", input.hostId) as { aggregate_version: number } | undefined;
    const eventInputs = events.map((event) => ({
      eventId: this.#nextUuid(),
      eventName: event.eventName,
      eventVersion: 1,
      correlationId: input.commandId,
      actor: { kind: "system" as const, actorId: this.#actorId },
      occurredAt: now,
      payload: event.payload,
    }));
    let notification: SessionInvalidationNotification | undefined;
    this.#journal.append(
      {
        aggregate: { aggregateType: "remote-host", aggregateId: input.hostId },
        expectedVersion: head?.aggregate_version ?? 0,
        events: eventInputs,
      },
      {
        beforeEvents: (connection) => {
          const targets = input.selectSessions(connection);
          const invalidate = connection.prepare(
            `UPDATE remote_session_store
             SET state = 'revoked'
             WHERE session_id_digest = ? AND host_id = ? AND device_id = ?
               AND credential_generation = ? AND state = 'active'`,
          );
          const sessionEvents = [] as Array<{
            readonly eventId: string;
            readonly eventName: string;
            readonly eventVersion: 1;
            readonly correlationId: string;
            readonly actor: { readonly kind: "system"; readonly actorId: string };
            readonly occurredAt: string;
            readonly payload: unknown;
          }>;
          const digests: string[] = [];
          const deviceIds = new Set<string>();
          for (const session of targets) {
            if (
              invalidate.run(
                session.session_id_digest,
                input.hostId,
                session.device_id,
                session.credential_generation,
              ).changes !== 1
            ) {
              throw new RemoteCredentialLifecycleError(
                "conflict",
                "Session state changed concurrently.",
              );
            }
            digests.push(session.session_id_digest);
            deviceIds.add(String(session.device_id));
            sessionEvents.push({
              eventId: this.#nextUuid(),
              eventName: REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated,
              eventVersion: 1,
              correlationId: input.commandId,
              actor: { kind: "system", actorId: this.#actorId },
              occurredAt: now,
              payload: {
                hostId: input.hostId,
                deviceId: session.device_id,
                sessionIdDigest: session.session_id_digest,
                credentialGeneration: session.credential_generation,
                invalidatedAt: now,
                reasonCode: input.reasonCode,
                receiptId: input.commandId,
              },
            });
          }
          notification = {
            hostId: input.hostId,
            deviceIds: [...deviceIds],
            sessionIdDigests: digests,
            reasonCode: input.reasonCode,
          };
          return sessionEvents;
        },
      },
    );
    if (notification !== undefined) {
      const cancellation = this.#notifyInvalidation(notification);
      return { commandId: input.commandId, result: "applied", occurredAt: now, cancellation };
    }
    return { commandId: input.commandId, result: "applied", occurredAt: now };
  }

  #invalidateAuthoritativeSessions(input: {
    readonly connection: SqliteConnection;
    readonly devices: ReadonlyArray<DeviceRegistrationProjectionRow>;
    readonly hostId: StableHostId;
    readonly reasonCode: string;
    readonly receiptId: string;
    readonly now: string;
  }): {
    readonly events: ReadonlyArray<{
      readonly eventId: string;
      readonly eventName: string;
      readonly eventVersion: 1;
      readonly correlationId: string;
      readonly actor: { readonly kind: "system"; readonly actorId: string };
      readonly occurredAt: string;
      readonly payload: unknown;
    }>;
    readonly sessionIdDigests: readonly string[];
  } {
    const select = input.connection.prepare(
      `SELECT session_id_digest, credential_generation
       FROM remote_session_store
       WHERE host_id = ? AND device_id = ? AND state = 'active'
       ORDER BY session_id_digest`,
    );
    const invalidate = input.connection.prepare(
      `UPDATE remote_session_store
       SET state = 'revoked'
       WHERE session_id_digest = ? AND host_id = ? AND device_id = ?
         AND credential_generation = ? AND state = 'active'`,
    );
    const targets: Array<{
      readonly device: DeviceRegistrationProjectionRow;
      readonly session: {
        readonly session_id_digest: string;
        readonly credential_generation: number;
      };
    }> = [];
    for (const device of input.devices) {
      const rows = select.all(input.hostId, device.device_id) as ReadonlyArray<{
        readonly session_id_digest: string;
        readonly credential_generation: number;
      }>;
      targets.push(...rows.map((session) => ({ device, session })));
    }

    const events = [] as Array<{
      readonly eventId: string;
      readonly eventName: string;
      readonly eventVersion: 1;
      readonly correlationId: string;
      readonly actor: { readonly kind: "system"; readonly actorId: string };
      readonly occurredAt: string;
      readonly payload: unknown;
    }>;
    const sessionIdDigests: string[] = [];
    for (const target of targets) {
      const { device, session } = target;
      if (
        invalidate.run(
          session.session_id_digest,
          input.hostId,
          device.device_id,
          session.credential_generation,
        ).changes !== 1
      ) {
        throw new RemoteCredentialLifecycleError("conflict", "Session state changed concurrently.");
      }
      sessionIdDigests.push(session.session_id_digest);
      events.push({
        eventId: this.#nextUuid(),
        eventName: REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated,
        eventVersion: 1,
        correlationId: input.receiptId,
        actor: { kind: "system", actorId: this.#actorId },
        occurredAt: input.now,
        payload: {
          hostId: input.hostId,
          deviceId: device.device_id,
          sessionIdDigest: session.session_id_digest,
          credentialGeneration: session.credential_generation,
          invalidatedAt: input.now,
          reasonCode: input.reasonCode,
          receiptId: input.receiptId,
        },
      });
    }
    return { events, sessionIdDigests };
  }

  #notifyInvalidation(input: SessionInvalidationNotification): SessionCancellationOutcome {
    if (this.#onSessionsInvalidated === undefined) {
      return { canceled: 0, cancelHookFailures: 0 };
    }
    try {
      return this.#onSessionsInvalidated(input);
    } catch {
      return { canceled: 0, cancelHookFailures: 1 };
    }
  }

  #selectActiveSessionsForCancellation(
    hostId: StableHostId,
    deviceId: string | undefined,
  ): ReadonlyArray<{
    readonly session_id_digest: string;
    readonly device_id: string;
    readonly credential_generation: number;
  }> {
    if (deviceId !== undefined) {
      return this.#connection
        .prepare(
          `SELECT session_id_digest, device_id, credential_generation
           FROM remote_session_store
           WHERE host_id = ? AND device_id = ? AND state = 'active'`,
        )
        .all(hostId, deviceId) as ReadonlyArray<{
        readonly session_id_digest: string;
        readonly device_id: string;
        readonly credential_generation: number;
      }>;
    }
    return this.#connection
      .prepare(
        `SELECT session_id_digest, device_id, credential_generation
         FROM remote_session_store
         WHERE host_id = ? AND state = 'active'`,
      )
      .all(hostId) as ReadonlyArray<{
      readonly session_id_digest: string;
      readonly device_id: string;
      readonly credential_generation: number;
    }>;
  }

  #requiredDevice(
    hostId: StableHostId,
    deviceId: string | undefined,
  ): DeviceRegistrationProjectionRow {
    if (deviceId === undefined) {
      throw new RemoteCredentialLifecycleError("invalid", "A device is required.");
    }
    const device = readDeviceRegistration(this.#connection, deviceId);
    if (device === undefined || device.host_id !== hostId) {
      throw new RemoteCredentialLifecycleError("not-found", "Device is unavailable.");
    }
    if (device.state !== "active") {
      throw new RemoteCredentialLifecycleError("conflict", "Device credential is unavailable.");
    }
    return device;
  }

  #cleanupReceipts(): void {
    this.#connection
      .prepare("DELETE FROM remote_command_receipt_projection WHERE expires_at <= ?")
      .run(this.#clock());
  }

  #nextUuid(): string {
    const value = this.#uuid();
    assertUuid(value, "event");
    return value;
  }
}

function assertUuid(value: string, kind: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new RemoteCredentialLifecycleError("invalid", `Invalid ${kind} identity.`);
  }
}

function assertRedactedCode(value: string, kind: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new RemoteCredentialLifecycleError("invalid", `Invalid ${kind} code.`);
  }
}

function assertUniqueDeviceRequests(values: ReadonlyArray<{ readonly deviceId: string }>): void {
  const ids = values.map((value) => value.deviceId);
  if (new Set(ids).size !== ids.length) {
    throw new RemoteCredentialLifecycleError("invalid", "Duplicate device entries are ambiguous.");
  }
}

function digestOperation(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateOperationDigest(value: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new RemoteCredentialLifecycleError("invalid", "Invalid operation digest.");
  }
}

function requireCanonicalDeviceKey(
  fingerprint: string,
  publicKey: string,
): CanonicalDeviceKeyFacts {
  const facts = canonicalDeviceKeyFacts(publicKey);
  if (facts === undefined || !deviceKeyFingerprintMatches(fingerprint, facts)) {
    throw new RemoteCredentialLifecycleError(
      "invalid",
      "Device key fingerprint does not match key.",
    );
  }
  return facts;
}

export function validateDeviceKeyFingerprint(value: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new RemoteCredentialLifecycleError("invalid", "Invalid device key fingerprint.");
  }
}

function verifyNewKeyRotationProof(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly newDeviceKeyFingerprint: string;
  readonly newDevicePublicKey: string;
  readonly newKeyProof: string;
}): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(input.newKeyProof) || input.newKeyProof.length > 512) {
    return false;
  }
  try {
    return verify(
      "sha256",
      Buffer.from(
        buildRemoteKeyRotationProofPayload({
          hostId: input.hostId,
          deviceId: input.deviceId,
          credentialGeneration: input.credentialGeneration,
          newDeviceKeyFingerprint: input.newDeviceKeyFingerprint,
          newDevicePublicKey: input.newDevicePublicKey,
        }),
        "utf8",
      ),
      { key: input.newDevicePublicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(input.newKeyProof, "base64url"),
    );
  } catch {
    return false;
  }
}
