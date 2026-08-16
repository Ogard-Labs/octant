import type { EventEnvelope } from "@octant/contracts";
import {
  REMOTE_ACCESS_EVENT_NAMES,
  type DeviceRegistrationV1,
  type HostIdentityInitializedV1,
  type DeviceKeyRotatedV1,
  type DeviceRevokedV1,
  type DeviceCredentialExpiredV1,
  type HostKeyRotatedV1,
  type RemoteCommandReceiptRecordedV1,
  type RemoteSessionInvalidatedV1,
  type SecurityAuditRecordedV1,
} from "@octant/contracts/remote-access";
import type { Projection } from "./projection";
import type { SqliteConnection, SqliteStatement } from "./sqlitePort";

interface ProjectionStatements {
  readonly host: SqliteStatement;
  readonly device: SqliteStatement;
  readonly rotate: SqliteStatement;
  readonly revoke: SqliteStatement;
  readonly expire: SqliteStatement;
  readonly hostRotate: SqliteStatement;
  readonly sessionInvalidate: SqliteStatement;
  readonly receipt: SqliteStatement;
  readonly audit: SqliteStatement;
}

export interface HostIdentityProjectionRow {
  readonly identity_key: "host";
  readonly host_id: string;
  readonly display_name: string;
  readonly key_fingerprint: string;
  readonly key_generation: number;
  readonly created_at: string;
  readonly rotated_at: string | null;
}

export interface DeviceRegistrationProjectionRow {
  readonly device_id: string;
  readonly host_id: string;
  readonly device_key_fingerprint: string;
  readonly device_public_key: string;
  readonly device_label: string;
  readonly origin: string;
  readonly protocol_floor: number;
  readonly credential_generation: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_seen_at: string;
  readonly state: "active" | "revoked" | "expired";
  readonly revoked_at: string | null;
  readonly revoked_reason: string | null;
}

export interface RemoteSessionInvalidationProjectionRow {
  readonly session_id_digest: string;
  readonly host_id: string;
  readonly device_id: string;
  readonly credential_generation: number;
  readonly state: "invalidated";
  readonly invalidated_at: string;
  readonly reason_code: string;
  readonly receipt_id: string;
}

export type AuthenticatedDeviceRegistrationProjectionRow = DeviceRegistrationV1 &
  DeviceRegistrationProjectionRow;

export class RemoteAccessProjection implements Projection {
  readonly name = "remote-access";
  readonly dependencies: ReadonlyArray<string> = [];
  #statements = new WeakMap<SqliteConnection, ProjectionStatements>();

  reset(connection: SqliteConnection): void {
    connection.exec(
      "DELETE FROM remote_device_projection; DELETE FROM remote_security_audit_projection; DELETE FROM remote_command_receipt_projection; DELETE FROM remote_session_invalidation_projection;",
    );
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    const payload = event.payload as Record<string, unknown>;
    const statements = this.#statementsFor(connection);
    switch (event.eventName) {
      case REMOTE_ACCESS_EVENT_NAMES.hostIdentityInitialized: {
        const value = payload as HostIdentityInitializedV1;
        statements.host.run(
          "host",
          value.hostId,
          value.displayName,
          value.hostKeyFingerprint,
          value.keyGeneration,
          value.createdAt,
          value.rotatedAt ?? null,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.deviceRegistered: {
        const value = payload as DeviceRegistrationV1 & { device: DeviceRegistrationV1 };
        const device = value.device;
        statements.device.run(
          device.deviceId,
          device.hostId,
          device.deviceKeyFingerprint,
          device.devicePublicKey,
          device.deviceLabel,
          device.origin,
          device.protocolFloor,
          device.credentialGeneration,
          device.createdAt,
          device.expiresAt,
          device.lastSeenAt,
          device.state,
          device.revokedAt ?? null,
          device.revokedReason ?? null,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.deviceKeyRotated: {
        const value = payload as DeviceKeyRotatedV1;
        statements.rotate.run(
          value.deviceKeyFingerprint,
          value.credentialGeneration,
          value.devicePublicKey,
          value.deviceId,
          value.hostId,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.deviceRevoked: {
        const value = payload as DeviceRevokedV1;
        statements.revoke.run(
          "revoked",
          value.revokedAt,
          value.reasonCode,
          value.credentialGeneration,
          value.deviceId,
          value.hostId,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.deviceCredentialExpired: {
        const value = payload as DeviceCredentialExpiredV1;
        statements.expire.run(
          "expired",
          value.reasonCode,
          value.deviceId,
          value.hostId,
          value.credentialGeneration,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.hostKeyRotated: {
        const value = payload as HostKeyRotatedV1;
        statements.hostRotate.run(
          value.hostKeyFingerprint,
          value.keyGeneration,
          value.rotatedAt,
          value.hostId,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated: {
        const value = payload as RemoteSessionInvalidatedV1;
        statements.sessionInvalidate.run(
          value.sessionIdDigest,
          value.hostId,
          value.deviceId,
          value.credentialGeneration,
          "invalidated",
          value.invalidatedAt,
          value.reasonCode,
          value.receiptId,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded: {
        const value = payload as RemoteCommandReceiptRecordedV1;
        statements.receipt.run(
          value.commandId,
          value.hostId,
          value.deviceId ?? null,
          value.operationKind,
          value.operationDigest,
          value.resultCategory,
          value.createdAt,
          value.expiresAt,
        );
        return;
      }
      case REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded: {
        const value = payload as SecurityAuditRecordedV1;
        const record = value.record;
        statements.audit.run(
          record.eventKind,
          record.hostId,
          record.deviceId ?? null,
          record.protocolVersion,
          record.credentialGeneration,
          record.sourceClass,
          record.resultCategory,
          record.reasonCode,
          record.correlationId,
          record.occurredAt,
        );
        return;
      }
      default:
        return;
    }
  }

  #statementsFor(connection: SqliteConnection): ProjectionStatements {
    const existing = this.#statements.get(connection);
    if (existing !== undefined) return existing;
    const statements = {
      host: connection.prepare(
        `INSERT INTO host_identity_projection (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(identity_key) DO UPDATE SET host_id = excluded.host_id, display_name = excluded.display_name, key_fingerprint = excluded.key_fingerprint, key_generation = excluded.key_generation, created_at = excluded.created_at, rotated_at = excluded.rotated_at`,
      ),
      device: connection.prepare(
        `INSERT INTO remote_device_projection (device_id, host_id, device_key_fingerprint, device_public_key, device_label, origin, protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state, revoked_at, revoked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET host_id = excluded.host_id, device_key_fingerprint = excluded.device_key_fingerprint, device_public_key = excluded.device_public_key, device_label = excluded.device_label, origin = excluded.origin, protocol_floor = excluded.protocol_floor, credential_generation = excluded.credential_generation, created_at = excluded.created_at, expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at, state = excluded.state, revoked_at = excluded.revoked_at, revoked_reason = excluded.revoked_reason`,
      ),
      rotate: connection.prepare(
        "UPDATE remote_device_projection SET device_key_fingerprint = ?, credential_generation = ?, device_public_key = ? WHERE device_id = ? AND host_id = ?",
      ),
      revoke: connection.prepare(
        "UPDATE remote_device_projection SET state = ?, revoked_at = ?, revoked_reason = ?, credential_generation = ? WHERE device_id = ? AND host_id = ?",
      ),
      expire: connection.prepare(
        "UPDATE remote_device_projection SET state = ?, revoked_reason = ? WHERE device_id = ? AND host_id = ? AND credential_generation = ?",
      ),
      hostRotate: connection.prepare(
        "UPDATE host_identity_projection SET key_fingerprint = ?, key_generation = ?, rotated_at = ? WHERE identity_key = 'host' AND host_id = ?",
      ),
      sessionInvalidate: connection.prepare(
        `INSERT INTO remote_session_invalidation_projection (session_id_digest, host_id, device_id, credential_generation, state, invalidated_at, reason_code, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id_digest) DO UPDATE SET host_id = excluded.host_id, device_id = excluded.device_id, credential_generation = excluded.credential_generation, state = excluded.state, invalidated_at = excluded.invalidated_at, reason_code = excluded.reason_code, receipt_id = excluded.receipt_id`,
      ),
      receipt: connection.prepare(
        `INSERT INTO remote_command_receipt_projection (command_id, host_id, device_id, operation_kind, operation_digest, result_category, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(command_id) DO UPDATE SET result_category = excluded.result_category WHERE remote_command_receipt_projection.host_id = excluded.host_id AND remote_command_receipt_projection.device_id IS excluded.device_id AND remote_command_receipt_projection.operation_kind = excluded.operation_kind AND remote_command_receipt_projection.operation_digest = excluded.operation_digest AND remote_command_receipt_projection.result_category = 'pending' AND excluded.result_category = 'applied'`,
      ),
      audit: connection.prepare(
        "INSERT INTO remote_security_audit_projection (event_kind, host_id, device_id, protocol_version, credential_generation, source_class, result_category, reason_code, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
    };
    this.#statements.set(connection, statements);
    return statements;
  }
}

export function readHostIdentity(
  connection: SqliteConnection,
): HostIdentityProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM host_identity_projection WHERE identity_key = 'host'")
    .get() as HostIdentityProjectionRow | undefined;
}

export function readDeviceRegistrations(
  connection: SqliteConnection,
): ReadonlyArray<DeviceRegistrationProjectionRow> {
  return connection
    .prepare("SELECT * FROM remote_device_projection ORDER BY device_id")
    .all() as ReadonlyArray<DeviceRegistrationProjectionRow>;
}

export function readRemoteSessionInvalidation(
  connection: SqliteConnection,
  sessionIdDigest: string,
): RemoteSessionInvalidationProjectionRow | undefined {
  return connection
    .prepare("SELECT * FROM remote_session_invalidation_projection WHERE session_id_digest = ?")
    .get(sessionIdDigest) as RemoteSessionInvalidationProjectionRow | undefined;
}

export function readRemoteCommandReceipt(
  connection: SqliteConnection,
  commandId: string,
): Record<string, unknown> | undefined {
  return connection
    .prepare("SELECT * FROM remote_command_receipt_projection WHERE command_id = ?")
    .get(commandId) as Record<string, unknown> | undefined;
}

export function readDeviceRegistration(
  connection: SqliteConnection,
  deviceId: string,
): AuthenticatedDeviceRegistrationProjectionRow | undefined {
  return connection
    .prepare(
      `SELECT
        remote_device_projection.*,
        device_id AS deviceId, host_id AS hostId,
        device_key_fingerprint AS deviceKeyFingerprint,
        device_public_key AS devicePublicKey, device_label AS deviceLabel,
        origin, protocol_floor AS protocolFloor,
        credential_generation AS credentialGeneration,
        created_at AS createdAt, expires_at AS expiresAt,
        last_seen_at AS lastSeenAt, state,
        revoked_at AS revokedAt, revoked_reason AS revokedReason
       FROM remote_device_projection WHERE device_id = ?`,
    )
    .get(deviceId) as AuthenticatedDeviceRegistrationProjectionRow | undefined;
}
