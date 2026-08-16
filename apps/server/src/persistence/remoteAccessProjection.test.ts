import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { Journal } from "./journal";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";
import {
  RemoteAccessProjection,
  readDeviceRegistrations,
  readHostIdentity,
  readRemoteCommandReceipt,
} from "./remoteAccessProjection";

const directories: string[] = [];
const now = "2026-07-28T20:00:00.000Z";
const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const deviceId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("RemoteAccessProjection", () => {
  it("projects redacted host and device lifecycle events and rebuilds them", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-remote-projection-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const projection = runtime.projections.get("remote-access");
    expect(projection).toBeInstanceOf(RemoteAccessProjection);
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });

    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 0,
      events: [
        {
          eventId: "55555555-5555-4555-8555-555555555555",
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
          eventId: "66666666-6666-4666-8666-666666666666",
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
              expiresAt: "2026-10-26T20:00:00.000Z",
              lastSeenAt: now,
              state: "active",
            },
          },
        },
      ],
    });

    expect(readHostIdentity(connection)).toMatchObject({ host_id: hostId, key_generation: 1 });
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
    rebuildProjection({ connection, journal, projection: projection!, clock: () => now });
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
    connection.close();
  });

  it("does not persist pairing proofs, cookies, paths, or authorization headers", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-remote-redaction-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    expect(() =>
      connection
        .prepare(
          "INSERT INTO remote_security_audit_projection (event_kind, host_id, device_id, protocol_version, credential_generation, source_class, result_category, reason_code, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "device-approved",
          hostId,
          deviceId,
          1,
          1,
          "lan-private",
          "approved",
          "user-approved",
          correlationId,
          now,
        ),
    ).not.toThrow();
    const persisted = JSON.stringify(
      connection.prepare("SELECT * FROM remote_security_audit_projection").all(),
    );
    expect(persisted).not.toMatch(/pairing|cookie|csrf|authorization|private key|\/Users\//i);
    connection.close();
  });

  // R1: Receipt integrity — pending -> applied transition is allowed for the
  // same receipt identity/metadata.
  it("allows pending -> applied transition for the same receipt identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-receipt-transition-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const commandId = "55555555-5555-4555-8555-555555555501";
    const operationDigest = "a".repeat(64);

    // Emit pending receipt.
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 0,
      events: [
        {
          eventId: "55555555-5555-4555-8555-555555555502",
          eventName: "remote.command-receipt-recorded@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            commandId,
            hostId,
            operationKind: "invalidate-all-sessions",
            operationDigest,
            resultCategory: "pending",
            createdAt: now,
            expiresAt: "2026-08-28T20:00:00.000Z",
          },
        },
      ],
    });
    let receipt = readRemoteCommandReceipt(connection, commandId);
    expect(receipt).toBeDefined();
    expect(String(receipt?.result_category)).toBe("pending");

    // Emit applied receipt with the SAME identity metadata.
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 1,
      events: [
        {
          eventId: "55555555-5555-4555-8555-555555555503",
          eventName: "remote.command-receipt-recorded@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            commandId,
            hostId,
            operationKind: "invalidate-all-sessions",
            operationDigest,
            resultCategory: "applied",
            createdAt: now,
            expiresAt: "2026-08-28T20:00:00.000Z",
          },
        },
      ],
    });
    receipt = readRemoteCommandReceipt(connection, commandId);
    expect(String(receipt?.result_category)).toBe("applied");
    connection.close();
  });

  // R1: Receipt integrity — a conflicting duplicate with different metadata
  // must NOT mutate the original receipt.
  it("rejects mismatched duplicate receipt that would mutate the original", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-receipt-conflict-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const commandId = "66666666-6666-4666-8666-666666666601";
    const operationDigest = "b".repeat(64);

    // Emit pending receipt for host A.
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 0,
      events: [
        {
          eventId: "66666666-6666-4666-8666-666666666602",
          eventName: "remote.command-receipt-recorded@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            commandId,
            hostId,
            operationKind: "invalidate-all-sessions",
            operationDigest,
            resultCategory: "pending",
            createdAt: now,
            expiresAt: "2026-08-28T20:00:00.000Z",
          },
        },
      ],
    });
    let receipt = readRemoteCommandReceipt(connection, commandId);
    expect(String(receipt?.result_category)).toBe("pending");
    expect(String(receipt?.host_id)).toBe(hostId);

    // Emit a conflicting receipt with a DIFFERENT host_id and operation_kind.
    // The projection must NOT update — the original pending receipt is
    // preserved.
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 1,
      events: [
        {
          eventId: "66666666-6666-4666-8666-666666666603",
          eventName: "remote.command-receipt-recorded@1",
          eventVersion: 1,
          correlationId,
          actor: { kind: "system", actorId },
          occurredAt: now,
          payload: {
            commandId,
            hostId: decodeStableHostId("99999999-9999-4999-8999-999999999999"),
            operationKind: "self-revoke",
            operationDigest: "c".repeat(64),
            resultCategory: "applied",
            createdAt: now,
            expiresAt: "2026-08-28T20:00:00.000Z",
          },
        },
      ],
    });
    receipt = readRemoteCommandReceipt(connection, commandId);
    // Original receipt preserved — no mutation.
    expect(String(receipt?.result_category)).toBe("pending");
    expect(String(receipt?.host_id)).toBe(hostId);
    expect(String(receipt?.operation_kind)).toBe("invalidate-all-sessions");
    expect(String(receipt?.operation_digest)).toBe(operationDigest);
    connection.close();
  });

  // R1: Idempotent identical replay — re-emitting the same pending receipt
  // does not corrupt or duplicate.
  it("idempotently handles identical receipt replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-receipt-idempotent-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const commandId = "77777777-7777-4777-8777-777777777701";
    const operationDigest = "d".repeat(64);

    const receiptEvent = {
      eventId: "77777777-7777-4777-8777-777777777702",
      eventName: "remote.command-receipt-recorded@1",
      eventVersion: 1 as const,
      correlationId,
      actor: { kind: "system" as const, actorId },
      occurredAt: now,
      payload: {
        commandId,
        hostId,
        operationKind: "invalidate-all-sessions",
        operationDigest,
        resultCategory: "pending",
        createdAt: now,
        expiresAt: "2026-08-28T20:00:00.000Z",
      },
    };

    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 0,
      events: [receiptEvent],
    });

    // Re-emit with a new event ID but identical metadata — the ON CONFLICT
    // WHERE clause does not match (pending -> pending is not the allowed
    // transition), so DO NOTHING preserves the original.
    journal.append({
      aggregate: { aggregateType: "remote-host", aggregateId: hostId },
      expectedVersion: 1,
      events: [
        {
          ...receiptEvent,
          eventId: "77777777-7777-4777-8777-777777777703",
        },
      ],
    });

    const receipt = readRemoteCommandReceipt(connection, commandId);
    expect(String(receipt?.result_category)).toBe("pending");
    connection.close();
  });
});
