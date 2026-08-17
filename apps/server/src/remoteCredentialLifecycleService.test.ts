import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { buildRemoteKeyRotationProofPayload } from "@octant/domain";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { rebuildProjection } from "./persistence/projection";
import {
  readDeviceRegistration,
  readRemoteCommandReceipt,
  readRemoteSessionInvalidation,
  readHostIdentity,
} from "./persistence/remoteAccessProjection";
import {
  RemoteCredentialLifecycleError,
  RemoteCredentialLifecycleService,
} from "./remoteCredentialLifecycleService";
import { canonicalDeviceKeyFacts } from "./remote/deviceKeyFacts";
import { createRemoteRequestRegistry } from "./remote/remoteRequestRegistry";

const directories: string[] = [];
const now = "2026-07-29T08:00:00.000Z";
const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const deviceId = "22222222-2222-4222-8222-222222222222";
const secondDeviceId = "abababab-abab-4aba-8aba-abababababab";
const sessionId = "33333333-3333-4333-8333-333333333333";
const sessionIdDigest = createHash("sha256").update(sessionId, "utf8").digest("hex");
const actorId = "44444444-4444-4444-8444-444444444444";
const correlationId = "55555555-5555-4555-8555-555555555555";

const testKeyCache = new Map<string, { publicPem: string; fingerprint: string }>();
function testKey(name: string) {
  const cached = testKeyCache.get(name);
  if (cached !== undefined) return cached;
  const publicPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString()
    .trim();
  const key = { publicPem, fingerprint: canonicalDeviceKeyFacts(publicPem)!.fingerprint };
  testKeyCache.set(name, key);
  return key;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createFixture(migrations = MIGRATIONS) {
  const directory = mkdtempSync(join(tmpdir(), "octant-remote-credentials-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, migrations, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  if (migrations.length >= 28) {
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 0,
      events: [
        {
          eventId: "66666666-6666-4666-8666-666666666666",
          eventName: "remote.host-identity-initialized@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            hostId,
            displayName: "This Mac",
            hostKeyFingerprint: "a".repeat(64),
            keyGeneration: 1,
            createdAt: now,
          },
        },
      ],
    });
    journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: deviceId },
      expectedVersion: 0,
      events: [
        {
          eventId: "77777777-7777-4777-8777-777777777777",
          eventName: "remote.device-registered@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            device: {
              hostId,
              deviceId,
              deviceKeyFingerprint: "b".repeat(64),
              devicePublicKey: "public-key",
              deviceLabel: "Safari",
              origin: "https://mac.example.test",
              protocolFloor: 1,
              credentialGeneration: 1,
              createdAt: now,
              expiresAt: "2026-10-29T08:00:00.000Z",
              lastSeenAt: now,
              state: "active",
            },
          },
        },
      ],
    });
  } else {
    connection
      .prepare(
        `INSERT INTO host_identity_projection
          (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at, rotated_at)
         VALUES ('host', ?, ?, ?, ?, ?, NULL)`,
      )
      .run(hostId, "This Mac", "a".repeat(64), 1, now);
    connection
      .prepare(
        `INSERT INTO remote_device_projection
          (device_id, host_id, device_key_fingerprint, device_public_key, device_label, origin,
           protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state,
           revoked_at, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`,
      )
      .run(
        deviceId,
        hostId,
        "b".repeat(64),
        "public-key",
        "Safari",
        "https://mac.example.test",
        1,
        1,
        now,
        "2026-10-29T08:00:00.000Z",
        now,
      );
  }
  connection
    .prepare(
      `INSERT INTO remote_session_store (
        session_id_digest, host_id, device_id, credential_generation, origin,
        protocol_version, capability_digest, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, csrf_digest, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      sessionIdDigest,
      hostId,
      deviceId,
      1,
      "https://mac.example.test",
      1,
      "c".repeat(64),
      Date.parse(now),
      Date.parse(now),
      Date.parse("2026-07-29T09:00:00.000Z"),
      Date.parse("2026-08-29T08:00:00.000Z"),
      "d".repeat(64),
    );
  return { connection, journal, runtime };
}

function insertAuthoritativeSession(
  connection: ReturnType<typeof openSqlite>,
  digest: string,
  generation: number,
  targetDeviceId = deviceId,
): void {
  connection
    .prepare(
      `INSERT INTO remote_session_store (
        session_id_digest, host_id, device_id, credential_generation, origin,
        protocol_version, capability_digest, issued_at, last_seen_at,
        idle_expires_at, absolute_expires_at, csrf_digest, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      digest,
      hostId,
      targetDeviceId,
      generation,
      "https://mac.example.test",
      1,
      "c".repeat(64),
      Date.parse(now),
      Date.parse(now),
      Date.parse("2026-07-29T09:00:00.000Z"),
      Date.parse("2026-08-29T08:00:00.000Z"),
      "d".repeat(64),
    );
}

describe("RemoteCredentialLifecycleService", () => {
  it("upgrades an exact v27 (signed request proof) store before replaying digest-only invalidation", () => {
    const fixture = createFixture(MIGRATIONS.slice(0, 27));
    const { connection, runtime } = fixture;
    expect(
      connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remote_session_invalidation_projection'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      connection
        .prepare(
          "SELECT name FROM pragma_table_info('remote_command_receipt_projection') WHERE name = 'operation_digest'",
        )
        .get(),
    ).toBeUndefined();

    expect(applyMigrations(connection, MIGRATIONS, () => now)).toMatchObject({
      currentVersion: MIGRATIONS.at(-1)!.version,
      appliedVersions: [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46],
    });
    expect(
      connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'remote_session_invalidation_device_idx'",
        )
        .get(),
    ).toEqual({ name: "remote_session_invalidation_device_idx" });
    expect(
      connection
        .prepare(
          "SELECT name FROM pragma_table_info('remote_command_receipt_projection') WHERE name IN ('operation_kind', 'operation_digest') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "operation_digest" }, { name: "operation_kind" }]);

    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `15151515-1515-4151-8151-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });
    expect(
      service.rotateDevice({
        commandId: "15151515-1515-4151-8151-111111111111",
        hostId,
        deviceId,
        newDeviceKeyFingerprint: testKey("upgrade-public-key").fingerprint,
        newDevicePublicKey: testKey("upgrade-public-key").publicPem,
      }),
    ).toMatchObject({ result: "applied" });
    expect(readRemoteSessionInvalidation(connection, sessionIdDigest)).toMatchObject({
      session_id_digest: sessionIdDigest,
    });
    rebuildProjection({
      connection,
      journal,
      projection: runtime.projections.get("remote-access")!,
      clock: () => now,
    });
    expect(readRemoteSessionInvalidation(connection, sessionIdDigest)).toMatchObject({
      session_id_digest: sessionIdDigest,
    });
    connection.close();
  });

  it("rotates one generation, invalidates its sessions, audits redacted facts, and is idempotent", () => {
    const { connection, journal, runtime } = createFixture();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        const ids = [
          "88888888-8888-4888-8888-888888888888",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        ];
        let next = 0;
        return () => ids[next++] ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      })(),
      clock: () => now,
    });

    const first = service.rotateDevice({
      commandId: "99999999-9999-4999-8999-999999999999",
      hostId,
      deviceId,
      newDeviceKeyFingerprint: testKey("replacement-public-key").fingerprint,
      newDevicePublicKey: testKey("replacement-public-key").publicPem,
    });
    expect(first).toMatchObject({
      result: "applied",
      commandId: "99999999-9999-4999-8999-999999999999",
    });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 2,
      device_key_fingerprint: testKey("replacement-public-key").fingerprint,
      state: "active",
    });
    expect(readRemoteSessionInvalidation(connection, sessionIdDigest)).toMatchObject({
      credential_generation: 1,
      state: "invalidated",
    });
    const journalHead = journal.headSequence();
    const auditRows = connection.prepare("SELECT * FROM remote_security_audit_projection").all();
    expect(JSON.stringify(auditRows)).not.toMatch(
      /private|proof|cookie|csrf|authorization|\/Users|192\.168/i,
    );
    expect(JSON.stringify(journal.replay({ afterSequence: 0, limit: 100 } as never))).not.toMatch(
      /private|proof|cookie|csrf|authorization|\/Users|192\.168/i,
    );

    const second = service.rotateDevice({
      commandId: "99999999-9999-4999-8999-999999999999",
      hostId,
      deviceId,
      newDeviceKeyFingerprint: testKey("replacement-public-key").fingerprint,
      newDevicePublicKey: testKey("replacement-public-key").publicPem,
    });
    expect(second.result).toBe("already-applied");
    expect(journal.headSequence()).toBe(journalHead);

    rebuildProjection({
      connection,
      journal,
      projection: runtime.projections.get("remote-access")!,
      clock: () => now,
    });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 2,
      device_key_fingerprint: testKey("replacement-public-key").fingerprint,
    });
    expect(readRemoteSessionInvalidation(connection, sessionIdDigest)).toMatchObject({
      state: "invalidated",
    });

    const restarted = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    expect(restarted.inspectCompatibility()).toEqual({ compatible: true });
    connection.close();
  });

  it("reconciles expiry and host-key recovery as fail-closed lifecycle events", () => {
    const { connection, journal } = createFixture();
    connection
      .prepare("UPDATE remote_device_projection SET expires_at = ? WHERE device_id = ?")
      .run("2026-07-28T08:00:00.000Z", deviceId);
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 1;
        return () => `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });

    expect(
      service.reconcileExpired({
        commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        hostId,
      }),
    ).toMatchObject({ result: "applied" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "expired",
      revoked_at: null,
    });
    expect(service.isDeviceGenerationUsable({ hostId, deviceId, presentedGeneration: 1 })).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    const recoveredSessionDigest = createHash("sha256")
      .update("recovery-stale-session", "utf8")
      .digest("hex");
    insertAuthoritativeSession(connection, recoveredSessionDigest, 7);

    expect(
      service.recoverHostKey({
        commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        hostId,
        newHostKeyFingerprint: "d".repeat(64),
        newKeyGeneration: 2,
      }),
    ).toMatchObject({ result: "applied" });
    expect(readHostIdentity(connection)).toMatchObject({
      key_fingerprint: "d".repeat(64),
      key_generation: 2,
    });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({ state: "revoked" });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(recoveredSessionDigest),
    ).toEqual({ state: "revoked" });
    connection.close();
  });

  it("invalidates stale active generations on single-device revoke", () => {
    const { connection, journal } = createFixture();
    const staleDigest = createHash("sha256").update("single-revoke-stale", "utf8").digest("hex");
    insertAuthoritativeSession(connection, staleDigest, 8);
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `14141414-1414-4141-8141-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });
    expect(
      service.revokeDevice({
        commandId: "14141414-1414-4141-8141-111111111111",
        hostId,
        deviceId,
      }),
    ).toMatchObject({ result: "applied" });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(staleDigest),
    ).toEqual({ state: "revoked" });
    connection.close();
  });

  it("invalidates every active authoritative generation by digest across rebuild and restart", () => {
    const { connection, journal, runtime } = createFixture();
    const staleSecret = "stale-prior-generation-session";
    const staleDigest = createHash("sha256").update(staleSecret, "utf8").digest("hex");
    insertAuthoritativeSession(connection, staleDigest, 9);
    let next = 1;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `12121212-1212-4121-8121-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
    });

    expect(
      service.revokeAll({
        commandId: "12121212-1212-4121-8121-111111111111",
        hostId,
      }),
    ).toMatchObject({ result: "applied" });
    expect(
      connection
        .prepare(
          "SELECT state FROM remote_session_store WHERE session_id_digest IN (?, ?) ORDER BY session_id_digest",
        )
        .all(sessionIdDigest, staleDigest),
    ).toEqual([{ state: "revoked" }, { state: "revoked" }]);
    const invalidationPayloads = connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'remote.session-invalidated@1' ORDER BY global_sequence",
      )
      .all() as Array<{ payload_json: string }>;
    expect(invalidationPayloads).toHaveLength(2);
    const decodedInvalidationPayloads = invalidationPayloads.map((row) =>
      JSON.parse(row.payload_json),
    );
    expect(JSON.stringify(decodedInvalidationPayloads)).not.toContain(staleSecret);
    expect(JSON.stringify(decodedInvalidationPayloads)).not.toContain('"sessionId"');
    expect(JSON.stringify(decodedInvalidationPayloads)).toContain('"sessionIdDigest"');
    expect(readRemoteSessionInvalidation(connection, staleDigest)).toMatchObject({
      session_id_digest: staleDigest,
      credential_generation: 9,
    });

    rebuildProjection({
      connection,
      journal,
      projection: runtime.projections.get("remote-access")!,
      clock: () => now,
    });
    const databasePath = connection
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => (row as { name: string }).name === "main") as { file: string };
    connection.close();
    const restarted = openSqlite(databasePath.file);
    applyMigrations(restarted, MIGRATIONS, () => now);
    expect(
      restarted
        .prepare(
          "SELECT state FROM remote_session_store WHERE session_id_digest IN (?, ?) ORDER BY session_id_digest",
        )
        .all(sessionIdDigest, staleDigest),
    ).toEqual([{ state: "revoked" }, { state: "revoked" }]);
    expect(readRemoteSessionInvalidation(restarted, staleDigest)).toMatchObject({
      session_id_digest: staleDigest,
    });
    expect(
      JSON.stringify(restarted.prepare("SELECT * FROM remote_security_audit_projection").all()),
    ).not.toContain(staleSecret);
    restarted.close();
  });

  it("enforces one operation-wide session invalidation bound before writes", () => {
    const { connection, journal } = createFixture();
    connection
      .prepare(
        `INSERT INTO remote_device_projection (
          device_id, host_id, device_key_fingerprint, device_public_key, device_label,
          origin, protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        secondDeviceId,
        hostId,
        "e".repeat(64),
        "public-key-2",
        "Chrome",
        "https://mac.example.test",
        1,
        1,
        now,
        "2026-10-29T08:00:00.000Z",
        now,
      );
    for (let index = 0; index < 129; index++) {
      insertAuthoritativeSession(
        connection,
        createHash("sha256").update(`first-${index}`, "utf8").digest("hex"),
        1,
      );
    }
    for (let index = 0; index < 128; index++) {
      insertAuthoritativeSession(
        connection,
        createHash("sha256").update(`second-${index}`, "utf8").digest("hex"),
        1,
        secondDeviceId,
      );
    }
    const journalHead = journal.headSequence();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => "13131313-1313-4131-8131-131313131313",
      clock: () => now,
    });

    expect(() =>
      service.rotateAll({
        commandId: "13131313-1313-4131-8131-111111111111",
        hostId,
        devices: [
          {
            deviceId,
            newDeviceKeyFingerprint: testKey("replacement-one").fingerprint,
            newDevicePublicKey: testKey("replacement-one").publicPem,
          },
          {
            deviceId: secondDeviceId,
            newDeviceKeyFingerprint: testKey("replacement-two").fingerprint,
            newDevicePublicKey: testKey("replacement-two").publicPem,
          },
        ],
      }),
    ).toThrow();
    expect(journal.headSequence()).toBe(journalHead);
    expect(
      connection
        .prepare("SELECT COUNT(*) AS count FROM remote_session_store WHERE state = 'active'")
        .get(),
    ).toEqual({
      count: 258,
    });
    connection.close();
  });

  it("rotates and revokes all active device generations atomically", () => {
    const { connection, journal } = createFixture();
    journal.append({
      aggregate: { aggregateType: "remote-device", aggregateId: secondDeviceId },
      expectedVersion: 0,
      events: [
        {
          eventId: "abababab-abab-4aba-8aba-111111111111",
          eventName: "remote.device-registered@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            device: {
              hostId,
              deviceId: secondDeviceId,
              deviceKeyFingerprint: "e".repeat(64),
              devicePublicKey: "public-key-2",
              deviceLabel: "Chrome",
              origin: "https://mac.example.test",
              protocolFloor: 1,
              credentialGeneration: 1,
              createdAt: now,
              expiresAt: "2026-10-29T08:00:00.000Z",
              lastSeenAt: now,
              state: "active",
            },
          },
        },
      ],
    });
    let next = 1;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
    });

    expect(
      service.rotateAll({
        commandId: "abababab-abab-4aba-8aba-222222222222",
        hostId,
        devices: [
          {
            deviceId,
            newDeviceKeyFingerprint: testKey("replacement-public-key-1").fingerprint,
            newDevicePublicKey: testKey("replacement-public-key-1").publicPem,
          },
          {
            deviceId: secondDeviceId,
            newDeviceKeyFingerprint: testKey("replacement-public-key-2").fingerprint,
            newDevicePublicKey: testKey("replacement-public-key-2").publicPem,
          },
        ],
      }),
    ).toMatchObject({ result: "applied" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 2,
    });
    expect(readDeviceRegistration(connection, secondDeviceId)).toMatchObject({
      credential_generation: 2,
    });

    expect(
      service.revokeAll({
        commandId: "abababab-abab-4aba-8aba-333333333333",
        hostId,
      }),
    ).toMatchObject({ result: "applied" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({ state: "revoked" });
    expect(readDeviceRegistration(connection, secondDeviceId)).toMatchObject({ state: "revoked" });
    expect(
      connection
        .prepare(
          "SELECT count(*) AS count FROM event_journal WHERE event_name = 'remote.device-revoked@1'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 3,
    });
    expect(readDeviceRegistration(connection, secondDeviceId)).toMatchObject({
      credential_generation: 3,
    });
    connection.close();
  });

  it("rejects duplicate or conflicting device entries before effects", () => {
    const { connection, journal } = createFixture();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `eeeeeeee-eeee-4eee-8eee-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });

    expect(() =>
      service.rotateAll({
        commandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef",
        hostId,
        devices: [
          {
            deviceId,
            newDeviceKeyFingerprint: testKey("duplicate-public-key-1").fingerprint,
            newDevicePublicKey: testKey("duplicate-public-key-1").publicPem,
          },
          {
            deviceId,
            newDeviceKeyFingerprint: testKey("duplicate-public-key-2").fingerprint,
            newDevicePublicKey: testKey("duplicate-public-key-2").publicPem,
          },
        ],
      }),
    ).toThrow(RemoteCredentialLifecycleError);
    expect(connection.prepare("SELECT count(*) AS count FROM event_journal").get()).toEqual({
      count: 2,
    });
    connection.close();
  });

  it("binds a command receipt to operation inputs rather than command id alone", () => {
    const { connection, journal } = createFixture();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `ffffffff-ffff-4fff-8fff-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });
    const commandId = "ffffffff-ffff-4fff-8fff-fffffffffff0";
    service.rotateDevice({
      commandId,
      hostId,
      deviceId,
      newDeviceKeyFingerprint: testKey("digest-public-key").fingerprint,
      newDevicePublicKey: testKey("digest-public-key").publicPem,
    });

    expect(() =>
      service.rotateDevice({
        commandId,
        hostId,
        deviceId,
        newDeviceKeyFingerprint: testKey("changed-digest-public-key").fingerprint,
        newDevicePublicKey: testKey("changed-digest-public-key").publicPem,
      }),
    ).toThrow(RemoteCredentialLifecycleError);

    expect(() =>
      service.revokeDevice({
        commandId,
        hostId,
        deviceId,
        reasonCode: "operator-requested",
      }),
    ).toThrow(RemoteCredentialLifecycleError);
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "active",
      credential_generation: 2,
    });
    connection.close();
  });
});

describe("canonical device key alignment", () => {
  it("rejects malformed, non-P256, and fingerprint-mismatched rotation keys generically", () => {
    const { connection, journal } = createFixture();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `12121212-1212-4212-8212-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });
    const commandId = () =>
      `13131313-1313-4313-8313-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;

    expect(() =>
      service.rotateDevice({
        commandId: commandId(),
        hostId,
        deviceId,
        newDeviceKeyFingerprint: "0".repeat(64),
        newDevicePublicKey: "not-a-public-key",
      }),
    ).toThrow(RemoteCredentialLifecycleError);

    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
      .publicKey.export({ format: "pem", type: "spki" })
      .toString()
      .trim();
    expect(() =>
      service.rotateDevice({
        commandId: commandId(),
        hostId,
        deviceId,
        newDeviceKeyFingerprint: "0".repeat(64),
        newDevicePublicKey: p384,
      }),
    ).toThrow(RemoteCredentialLifecycleError);

    expect(() =>
      service.rotateDevice({
        commandId: commandId(),
        hostId,
        deviceId,
        newDeviceKeyFingerprint: testKey("mismatched-other").fingerprint,
        newDevicePublicKey: testKey("mismatched-self").publicPem,
      }),
    ).toThrow(RemoteCredentialLifecycleError);
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 1,
    });
    connection.close();
  });

  it("stores the canonical SPKI form and DER fingerprint on rotation", () => {
    const { connection, journal } = createFixture();
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: (() => {
        let next = 0;
        return () => `14141414-1414-4414-8414-${(next++).toString(16).padStart(12, "0")}`;
      })(),
      clock: () => now,
    });
    const canonical = testKey("canonical-rotation");
    const spacedPem = `-----BEGIN PUBLIC KEY-----\n${canonical.publicPem.replace(
      /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g,
      "",
    )}\n-----END PUBLIC KEY-----`;
    service.rotateDevice({
      commandId: "14141414-1414-4414-8414-141414141414",
      hostId,
      deviceId,
      newDeviceKeyFingerprint: canonical.fingerprint,
      newDevicePublicKey: spacedPem,
    });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      device_public_key: canonical.publicPem,
      device_key_fingerprint: canonical.fingerprint,
      credential_generation: 2,
    });
    connection.close();
  });

  it("signs out only the cookie-backed session digest without revoking the device", () => {
    const { connection, journal } = createFixture();
    const otherDigest = createHash("sha256").update("other-session", "utf8").digest("hex");
    insertAuthoritativeSession(connection, otherDigest, 1);
    const canceled = vi.fn();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: canceled,
    });
    const otherCancel = vi.fn();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest: otherDigest,
      cancel: otherCancel,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `15151515-1515-4151-8151-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const digest of input.sessionIdDigests) {
          const result = registry.cancelBySession(digest);
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });

    const receipt = service.signOut({
      commandId: "15151515-1515-4151-8151-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(receipt).toMatchObject({ result: "applied" });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(otherDigest),
    ).toEqual({ state: "active" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "active",
      credential_generation: 1,
    });
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(otherCancel).not.toHaveBeenCalled();
    expect(
      JSON.stringify(connection.prepare("SELECT payload_json FROM event_journal").all()),
    ).not.toContain(sessionId);
    expect(
      JSON.stringify(connection.prepare("SELECT payload_json FROM event_journal").all()),
    ).toContain(sessionIdDigest);
    expect(
      service.signOut({
        commandId: "15151515-1515-4151-8151-aaaaaaaaaaaa",
        hostId,
        deviceId,
        sessionIdDigest,
      }),
    ).toMatchObject({ result: "already-applied" });
    connection.close();
  });

  it("self-rotates only after dual old/new key possession and cancels device work", () => {
    const { connection, journal } = createFixture();
    const newKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const newPublicPem = newKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString()
      .trim();
    const newFingerprint = canonicalDeviceKeyFacts(newPublicPem)!.fingerprint;
    const newPrivatePem = newKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const rotationPayload = buildRemoteKeyRotationProofPayload({
      hostId,
      deviceId,
      credentialGeneration: 1,
      newDeviceKeyFingerprint: newFingerprint,
      newDevicePublicKey: newPublicPem,
    });
    const newKeyProof = sign("sha256", Buffer.from(rotationPayload), {
      key: newPrivatePem,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const canceled = vi.fn();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: canceled,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `16161616-1616-4161-8161-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const device of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: device });
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });

    expect(() =>
      service.selfRotateDevice({
        commandId: "16161616-1616-4161-8161-bbbbbbbbbbbb",
        hostId,
        deviceId,
        credentialGeneration: 1,
        newDeviceKeyFingerprint: newFingerprint,
        newDevicePublicKey: newPublicPem,
        newKeyProof: "forged_signature",
      }),
    ).toThrow(RemoteCredentialLifecycleError);
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 1,
    });
    expect(canceled).not.toHaveBeenCalled();

    const receipt = service.selfRotateDevice({
      commandId: "16161616-1616-4161-8161-cccccccccccc",
      hostId,
      deviceId,
      credentialGeneration: 1,
      newDeviceKeyFingerprint: newFingerprint,
      newDevicePublicKey: newPublicPem,
      newKeyProof,
    });
    expect(receipt).toMatchObject({ result: "applied" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      credential_generation: 2,
      device_key_fingerprint: newFingerprint,
      device_public_key: newPublicPem,
    });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    expect(canceled).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("self-revokes the authenticated device only and cancels matching work before return", () => {
    const { connection, journal } = createFixture();
    connection
      .prepare(
        `INSERT INTO remote_device_projection (
          device_id, host_id, device_key_fingerprint, device_public_key, device_label,
          origin, protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        secondDeviceId,
        hostId,
        "e".repeat(64),
        "public-key-2",
        "Chrome",
        "https://mac.example.test",
        1,
        1,
        now,
        "2026-10-29T08:00:00.000Z",
        now,
      );
    const otherDigest = createHash("sha256").update("second-device-session", "utf8").digest("hex");
    insertAuthoritativeSession(connection, otherDigest, 1, secondDeviceId);
    const selfCancel = vi.fn();
    const otherCancel = vi.fn();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: selfCancel,
    });
    registry.register({
      hostId,
      deviceId: secondDeviceId,
      sessionIdDigest: otherDigest,
      cancel: otherCancel,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `17171717-1717-4171-8171-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: id });
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });

    const receipt = service.selfRevokeDevice({
      commandId: "17171717-1717-4171-8171-dddddddddddd",
      hostId,
      deviceId,
    });
    expect(receipt).toMatchObject({ result: "applied" });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({ state: "revoked" });
    expect(readDeviceRegistration(connection, secondDeviceId)).toMatchObject({ state: "active" });
    expect(selfCancel).toHaveBeenCalledTimes(1);
    expect(otherCancel).not.toHaveBeenCalled();
    connection.close();
  });

  it("invalidates all sessions on restart while durable device registrations survive", () => {
    const { connection, journal } = createFixture();
    const secondDigest = createHash("sha256").update("restart-session-2", "utf8").digest("hex");
    insertAuthoritativeSession(connection, secondDigest, 1);
    const cancelA = vi.fn();
    const cancelB = vi.fn();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: cancelA,
    });
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest: secondDigest,
      cancel: cancelB,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `18181818-1818-4181-8181-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: () => {
        const result = registry.cancelAll();
        return result;
      },
    });

    const receipt = service.invalidateAllSessions({
      commandId: "18181818-1818-4181-8181-eeeeeeeeeeee",
      hostId,
      reasonCode: "server-restart",
    });
    expect(receipt).toMatchObject({ result: "applied" });
    expect(
      connection
        .prepare("SELECT COUNT(*) AS count FROM remote_session_store WHERE state = 'active'")
        .get(),
    ).toEqual({ count: 0 });
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "active",
      credential_generation: 1,
    });
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(cancelB).toHaveBeenCalledTimes(1);
    expect(
      service.invalidateAllSessions({
        commandId: "18181818-1818-4181-8181-eeeeeeeeeeee",
        hostId,
        reasonCode: "server-restart",
      }),
    ).toMatchObject({ result: "already-applied" });
    connection.close();
  });

  it("invokes the cancellation hook for direct host rotate/revoke mutations", () => {
    const { connection, journal } = createFixture();
    const canceled = vi.fn();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: canceled,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `19191919-1919-4191-8191-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: id });
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });
    service.revokeDevice({
      commandId: "19191919-1919-4191-8191-ffffffffffff",
      hostId,
      deviceId,
    });
    expect(canceled).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("reports a truthful cancellation outcome when the cancel hook throws", () => {
    const { connection, journal } = createFixture();
    const registry = createRemoteRequestRegistry();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: () => {
        throw new Error("cancel boom");
      },
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `1a1a1a1a-1a1a-41a1-81a1-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: id });
          cancelHookFailures += result.cancelHookFailures;
        }
        return {
          canceled: input.sessionIdDigests.length,
          cancelHookFailures,
        };
      },
    });
    const receipt = service.signOut({
      commandId: "1a1a1a1a-1a1a-41a1-81a1-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(receipt.result).toBe("applied");
    expect(receipt.cancellation).toEqual({ canceled: 1, cancelHookFailures: 1 });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    connection.close();
  });

  it("re-attempts cancellation on a lost-response retry and reports a truthful outcome", () => {
    const { connection, journal } = createFixture();
    const retryDigest = createHash("sha256").update("retry-session", "utf8").digest("hex");
    const registry = createRemoteRequestRegistry();
    const cancel = vi.fn();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `1b1b1b1b-1b1b-41b1-81b1-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: id });
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });
    // First sign-out: the cancel hook fires but the response is "lost"
    // (simulated by not checking the receipt). The session is revoked.
    const first = service.signOut({
      commandId: "1b1b1b1b-1b1b-41b1-81b1-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(first.result).toBe("applied");
    expect(first.cancellation?.canceled).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);

    // Simulate a second active session that survived the first invalidation
    // (e.g. a request that was in-flight when the response was lost).
    const retryCancel = vi.fn();
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest: retryDigest,
      cancel: retryCancel,
    });
    connection
      .prepare(
        `INSERT INTO remote_session_store (
          session_id_digest, host_id, device_id, credential_generation, origin,
          protocol_version, capability_digest, issued_at, last_seen_at,
          idle_expires_at, absolute_expires_at, csrf_digest, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        retryDigest,
        hostId,
        deviceId,
        1,
        "https://mac.example.test",
        1,
        "c".repeat(64),
        Date.parse(now),
        Date.parse(now),
        Date.parse("2026-07-29T09:00:00.000Z") + 60_000,
        Date.parse("2026-08-29T08:00:00.000Z"),
        "e".repeat(64),
      );

    // Retry with the same commandId: returns already-applied but re-cancels
    // the surviving active work on the same device.
    const retry = service.signOut({
      commandId: "1b1b1b1b-1b1b-41b1-81b1-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(retry.result).toBe("already-applied");
    expect(retry.cancellation?.canceled).toBe(1);
    expect(retryCancel).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("invalidates more than 256 active sessions on restart/disable without rejecting", () => {
    const { connection, journal } = createFixture();
    // Insert 300 active sessions for the host.
    for (let i = 0; i < 300; i++) {
      const digest = i.toString(16).padStart(64, "0");
      connection
        .prepare(
          `INSERT INTO remote_session_store (
            session_id_digest, host_id, device_id, credential_generation, origin,
            protocol_version, capability_digest, issued_at, last_seen_at,
            idle_expires_at, absolute_expires_at, csrf_digest, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          digest,
          hostId,
          deviceId,
          1,
          "https://mac.example.test",
          1,
          "c".repeat(64),
          Date.parse(now),
          Date.parse(now),
          Date.parse("2026-07-29T09:00:00.000Z") + 60_000,
          Date.parse("2026-08-29T08:00:00.000Z"),
          (i + 10).toString(16).padStart(64, "0"),
        );
    }
    const activeCount = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    expect(activeCount.count).toBe(301); // 300 + the original fixture session

    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `1c1c1c1c-1c1c-41c1-81c1-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
    });
    const receipt = service.invalidateAllSessions({
      commandId: "1c1c1c1c-1c1c-41c1-81c1-aaaaaaaaaaaa",
      hostId,
      reasonCode: "restart",
    });
    expect(receipt.result).toBe("applied");
    const remainingActive = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    expect(remainingActive.count).toBe(0);
    // Device registrations are preserved.
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "active",
      credential_generation: 1,
    });
    connection.close();
  });

  // S2: Retained failed registry entries can be retried with the same command ID.
  // The retry invokes the SAME retained target/hook, succeeds, drains the registry,
  // and returns already-applied with zero failures.
  it("retries the same retained cancel hook after a failure and returns already-applied with zero failures", () => {
    const { connection, journal } = createFixture();
    const registry = createRemoteRequestRegistry();
    let cancelShouldFail = true;
    const cancelHook = vi.fn(() => {
      if (cancelShouldFail) throw new Error("transient cancel failure");
    });
    registry.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: cancelHook,
    });
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `2a2a2a2a-2a2a-42a2-82a2-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        let canceled = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry.cancelByDevice({ hostId: input.hostId, deviceId: id });
          canceled += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        return { canceled, cancelHookFailures };
      },
    });

    // First sign-out: cancel hook fails. Durable invalidation commits.
    const first = service.signOut({
      commandId: "2a2a2a2a-2a2a-42a2-82a2-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(first.result).toBe("applied");
    expect(first.cancellation).toEqual({ canceled: 1, cancelHookFailures: 1 });
    // S2: The failed entry is retained.
    expect(registry.size()).toBe(1);
    expect(cancelHook).toHaveBeenCalledTimes(1);

    // Now let the cancel hook succeed.
    cancelShouldFail = false;

    // Retry with the same command ID — invokes the SAME retained hook.
    const retry = service.signOut({
      commandId: "2a2a2a2a-2a2a-42a2-82a2-aaaaaaaaaaaa",
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(retry.result).toBe("already-applied");
    expect(retry.cancellation).toEqual({ canceled: 1, cancelHookFailures: 0 });
    // S2: The retained entry is drained.
    expect(registry.size()).toBe(0);
    // The SAME hook was invoked again.
    expect(cancelHook).toHaveBeenCalledTimes(2);
    connection.close();
  });

  // B3: Bounded batching — over-bound population, batch boundary, all sessions
  // revoked, devices preserved, bounded work per append. Asserts max
  // rows/events/notification targets per batch for >2 batch sizes.
  it("invalidates 600 active sessions in bounded batches with bounded per-batch work", () => {
    const { connection, journal } = createFixture();
    // Insert 600 active sessions for the host (total 601 with the fixture session).
    for (let i = 0; i < 600; i++) {
      const digest = i.toString(16).padStart(64, "0");
      connection
        .prepare(
          `INSERT INTO remote_session_store (
            session_id_digest, host_id, device_id, credential_generation, origin,
            protocol_version, capability_digest, issued_at, last_seen_at,
            idle_expires_at, absolute_expires_at, csrf_digest, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          digest,
          hostId,
          deviceId,
          1,
          "https://mac.example.test",
          1,
          "c".repeat(64),
          Date.parse(now),
          Date.parse(now),
          Date.parse("2026-07-29T09:00:00.000Z") + 60_000,
          Date.parse("2026-08-29T08:00:00.000Z"),
          (i + 10).toString(16).padStart(64, "0"),
        );
    }
    const activeCount = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    expect(activeCount.count).toBe(601);

    // B3: Track per-batch notification targets to verify they are bounded.
    const batchNotificationSizes: number[] = [];
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `2b2b2b2b-2b2b-42b2-82b2-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
      onSessionsInvalidated: (input) => {
        batchNotificationSizes.push(input.sessionIdDigests.length);
        return { canceled: input.sessionIdDigests.length, cancelHookFailures: 0 };
      },
    });
    const receipt = service.invalidateAllSessions({
      commandId: "2b2b2b2b-2b2b-42b2-82b2-aaaaaaaaaaaa",
      hostId,
      reasonCode: "restart",
    });
    expect(receipt.result).toBe("applied");
    // All sessions revoked.
    const remainingActive = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    expect(remainingActive.count).toBe(0);
    // Device registrations are preserved.
    expect(readDeviceRegistration(connection, deviceId)).toMatchObject({
      state: "active",
      credential_generation: 1,
    });
    // B3: Assert >2 batches were processed (601 / 256 = 3 batches).
    expect(batchNotificationSizes.length).toBe(3);
    // B3: Assert each batch notification is bounded by SESSION_INVALIDATION_BATCH_SIZE (256).
    for (const size of batchNotificationSizes) {
      expect(size).toBeLessThanOrEqual(256);
    }
    // B3: Assert batch sizes are 256, 256, 89 (601 total).
    expect(batchNotificationSizes[0]).toBe(256);
    expect(batchNotificationSizes[1]).toBe(256);
    expect(batchNotificationSizes[2]).toBe(89);
    connection.close();
  });

  // R2: B1 atomic rollback — a real fault inside the journal transaction
  // after beforeEvents has run the UPDATE. The fault is a duplicate event
  // ID: the UUID generator produces an ID that already exists in the journal
  // (from the first batch), so the journal's duplicate check fires after
  // beforeEvents has already revoked the rows. The transaction rolls back,
  // restoring both rows and events. Then reconstruct/retry succeeds.
  it("rolls back batch UPDATE and events when journal transaction fails after beforeEvents", () => {
    const { connection, journal } = createFixture();
    // Insert 300 active sessions (total 301 with fixture).
    for (let i = 0; i < 300; i++) {
      const digest = i.toString(16).padStart(64, "0");
      connection
        .prepare(
          `INSERT INTO remote_session_store (
            session_id_digest, host_id, device_id, credential_generation, origin,
            protocol_version, capability_digest, issued_at, last_seen_at,
            idle_expires_at, absolute_expires_at, csrf_digest, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        )
        .run(
          digest,
          hostId,
          deviceId,
          1,
          "https://mac.example.test",
          1,
          "c".repeat(64),
          Date.parse(now),
          Date.parse(now),
          Date.parse("2026-07-29T09:00:00.000Z") + 60_000,
          Date.parse("2026-08-29T08:00:00.000Z"),
          (i + 10).toString(16).padStart(64, "0"),
        );
    }

    // R2: Use a UUID generator that produces a duplicate event ID on the
    // 2nd batch. The first batch's event IDs are consumed by the pending
    // receipt (2 events) and the first batch (256 events). The 2nd batch
    // will get event IDs that collide with the first batch's IDs, causing
    // the journal to throw DuplicateEventIdentity AFTER beforeEvents has
    // already run the UPDATE — proving atomic rollback.
    let next = 0;
    const crashService = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => {
        next++;
        // The pending receipt uses UUIDs 1-2. The first batch uses UUIDs 3-258.
        // The 2nd batch starts at UUID 259. We make UUID 259 collide with
        // UUID 3 (the first event of the first batch), causing a duplicate
        // event ID inside the journal transaction after beforeEvents has
        // already revoked the 2nd batch's rows.
        if (next === 259) {
          return "2c2c2c2c-2c2c-42c2-82c2-000000000003";
        }
        return `2c2c2c2c-2c2c-42c2-82c2-${next.toString(16).padStart(12, "0")}`;
      },
      clock: () => now,
    });

    // R2: The first call should throw when the 2nd batch's duplicate event
    // ID is detected — AFTER beforeEvents has already revoked the rows.
    // The transaction rolls back, restoring the 2nd batch's rows.
    expect(() =>
      crashService.invalidateAllSessions({
        commandId: "2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa",
        hostId,
        reasonCode: "restart",
      }),
    ).toThrow();

    // R2: The pending receipt is durable.
    const pendingReceipt = readRemoteCommandReceipt(
      connection,
      "2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa",
    );
    expect(pendingReceipt).toBeDefined();
    expect(String(pendingReceipt?.result_category)).toBe("pending");

    // R2: The first batch (256 sessions) was committed atomically — rows
    // revoked AND events emitted. The 2nd batch rolled back — rows restored
    // to active, no events emitted.
    const activeAfterCrash = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    // 301 total - 256 first batch = 45 remaining active (2nd batch rolled back).
    expect(activeAfterCrash.count).toBe(45);

    // R2: Verify no revoked rows without events — count sessionInvalidated
    // events in the journal and compare with revoked rows. The 2nd batch's
    // rows were rolled back, so revoked count == event count == 256.
    const revokedCount = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'revoked'",
      )
      .get(hostId) as { count: number };
    const invalidatedEventCount = connection
      .prepare(
        `SELECT COUNT(*) AS count FROM event_journal
         WHERE event_name = 'remote.session-invalidated@1'
           AND correlation_id = ?`,
      )
      .get("2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa") as { count: number };
    // R2: Every revoked row has a corresponding event (atomic).
    expect(revokedCount.count).toBe(invalidatedEventCount.count);
    expect(revokedCount.count).toBe(256);

    // R2: Reconstruct the service with a fresh UUID generator (simulating
    // restart) and retry.
    let restartNext = 0;
    const restartService = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `2d2d2d2d-2d2d-42d2-82d2-${(restartNext++).toString(16).padStart(12, "0")}`,
      clock: () => now,
    });

    // R2: Retry with the same command ID — finds the pending receipt,
    // resumes, invalidates remaining 45 sessions, marks applied.
    const retry = restartService.invalidateAllSessions({
      commandId: "2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa",
      hostId,
      reasonCode: "restart",
    });
    expect(retry.result).toBe("applied");

    // R2: All sessions revoked.
    const remainingActive = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'active'",
      )
      .get(hostId) as { count: number };
    expect(remainingActive.count).toBe(0);

    // R2: The receipt is now applied.
    const finalReceipt = readRemoteCommandReceipt(
      connection,
      "2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa",
    );
    expect(String(finalReceipt?.result_category)).toBe("applied");

    // R2: Verify all revoked rows have corresponding events (atomic).
    const finalRevokedCount = connection
      .prepare(
        "SELECT COUNT(*) AS count FROM remote_session_store WHERE host_id = ? AND state = 'revoked'",
      )
      .get(hostId) as { count: number };
    const finalEventCount = connection
      .prepare(
        `SELECT COUNT(*) AS count FROM event_journal
         WHERE event_name = 'remote.session-invalidated@1'
           AND correlation_id = ?`,
      )
      .get("2c2c2c2c-2c2c-42c2-82c2-aaaaaaaaaaaa") as { count: number };
    expect(finalRevokedCount.count).toBe(finalEventCount.count);
    expect(finalRevokedCount.count).toBe(301);
    connection.close();
  });

  // B2: Retry after completed operation returns already-applied.
  it("returns already-applied when retrying a completed invalidate-all-sessions", () => {
    const { connection, journal } = createFixture();
    let next = 0;
    const service = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId,
      uuid: () => `2d2d2d2d-2d2d-42d2-82d2-${(next++).toString(16).padStart(12, "0")}`,
      clock: () => now,
    });
    const first = service.invalidateAllSessions({
      commandId: "2d2d2d2d-2d2d-42d2-82d2-aaaaaaaaaaaa",
      hostId,
      reasonCode: "restart",
    });
    expect(first.result).toBe("applied");
    const retry = service.invalidateAllSessions({
      commandId: "2d2d2d2d-2d2d-42d2-82d2-aaaaaaaaaaaa",
      hostId,
      reasonCode: "restart",
    });
    expect(retry.result).toBe("already-applied");
    connection.close();
  });
});
