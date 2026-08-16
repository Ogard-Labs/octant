import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostIdentityMigrationFailed,
  initializeFreshHostIdentity,
  migrateLegacyHostIdentity,
  type HostIdentityKeyStore,
} from "./hostIdentityMigration";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { Persistence, makePersistenceLive } from "./persistenceService";
import { rebuildProjections } from "./projection";
import {
  readDeviceRegistrations,
  readHostIdentity,
  RemoteAccessProjection,
} from "./remoteAccessProjection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

/**
 * Remote exit evidence C — migration/Keychain recovery evidence
 * that CAN run on a Linux cloud runner. These rows exercise the production
 * host-identity migration transforms (`createRuntimeHostIdentityMigrationRegistry`)
 * and the real `RemoteAccessProjection`, so the remote native exit-evidence
 * matrix maps one-to-one to executable assertions.
 *
 * The packaged Apple-Silicon listener/Keychain/device rows that a Linux runner
 * cannot execute are named skips in the evidence packet, not silent gaps.
 */

const directories: string[] = [];
const now = "2026-08-03T20:00:00.000Z";
const legacyHostId = "local";
const stableHostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const deviceId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";

// Representative aggregate ids for the populated pre-upgrade store. A real
// legacy store holds Chat/Work/Code/layout host-bearing records, not only two
// remote-access events, so the migration exercises the envelope-only transforms
// (Chat/Work/Code) and the embedded-host layout transform, and a full
// projection rebuild replays every migrated payload.
const chatThreadId = "84000000-0000-4000-8000-000000000001";
const chatProviderId = "84000000-0000-4000-8000-000000000003";
const codeThreadId = "82000000-0000-4000-8000-000000000001";
const workThreadId = "83000000-0000-4000-8000-000000000001";
const windowId = "10000000-0000-4000-8000-000000000001";

const keyFingerprint = "a".repeat(64);
const keyStore: HostIdentityKeyStore = {
  ensureKey: async () => ({ fingerprint: keyFingerprint }),
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function freshStore(prefix: string): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

const insertLegacyRow = (
  connection: SqliteConnection,
  row: {
    readonly eventId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  },
): void => {
  connection
    .prepare(
      "INSERT INTO event_journal (event_id, aggregate_type, aggregate_id, aggregate_version, event_name, event_version, host_id, correlation_id, actor_kind, actor_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.eventId,
      row.aggregateType,
      row.aggregateId,
      1,
      row.eventName,
      1,
      legacyHostId,
      correlationId,
      "system",
      actorId,
      now,
      JSON.stringify(row.payload),
    );
};

/**
 * A `workspace.layout-replaced` payload whose context keys and preview tab carry
 * the legacy `local` host, so the migration's real embedded-host layout
 * transform (not just the envelope rewrite) is exercised. The shape mirrors the
 * strict payload validated in `runtimeRegistry.test.ts`.
 */
function legacyWorkspaceLayoutPayload(hostId: string): unknown {
  const group = (prefix: string, mode: "chat" | "work" | "code") => ({
    kind: "group" as const,
    nodeId: `${prefix}0000000-0000-4000-8000-000000000001`,
    groupId: `${prefix}0000000-0000-4000-8000-000000000002`,
    tabs: [
      {
        kind: "welcome" as const,
        id: `${prefix}0000000-0000-4000-8000-000000000003`,
        mode,
        title: `Welcome to ${mode}`,
      },
    ],
    activeTabId: `${prefix}0000000-0000-4000-8000-000000000003`,
  });
  return {
    workspace: {
      windowId,
      activeMode: "code",
      layouts: { chat: group("1", "chat"), work: group("2", "work"), code: group("3", "code") },
      activeGroupIds: {
        chat: "10000000-0000-4000-8000-000000000002",
        work: "20000000-0000-4000-8000-000000000002",
        code: "30000000-0000-4000-8000-000000000002",
      },
      contextByMode: {
        chat: { host: hostId, mode: "chat", projectId: null, boundRoot: null },
        work: { host: hostId, mode: "work", projectId: null, boundRoot: null },
        code: { host: hostId, mode: "code", projectId: null, boundRoot: null },
      },
      version: 1,
    },
  };
}

/**
 * Seed a realistic populated store whose events were authored under the legacy
 * `local` host id (raw insert bypasses the strict wire schema exactly the way a
 * pre-stable-identity store on disk would look). It holds the complex records a
 * real legacy store carries — Chat/Work/Code threads and a host-bearing
 * workspace layout — alongside the remote-access host identity and device, so
 * the migration exercises the envelope-only transforms, the embedded-host
 * layout transform, and a full projection rebuild. After the migration rewrites
 * them to the stable host id the payloads validate again and replay.
 */
function seedPopulatedLegacyStore(connection: SqliteConnection): void {
  insertLegacyRow(connection, {
    eventId: "55555555-5555-4555-8555-555555555555",
    aggregateType: "remote-host",
    aggregateId: stableHostId,
    eventName: "remote.host-identity-initialized@1",
    payload: {
      hostId: legacyHostId,
      displayName: "This Mac",
      hostKeyFingerprint: keyFingerprint,
      keyGeneration: 1,
      createdAt: now,
    },
  });
  insertLegacyRow(connection, {
    eventId: "66666666-6666-4666-8666-666666666666",
    aggregateType: "remote-device",
    aggregateId: deviceId,
    eventName: "remote.device-registered@1",
    payload: {
      device: {
        hostId: legacyHostId,
        deviceId,
        deviceKeyFingerprint: "b".repeat(64),
        devicePublicKey: "public-key",
        deviceLabel: "Safari",
        origin: "https://mac.example.test",
        protocolFloor: 1,
        credentialGeneration: 1,
        createdAt: now,
        expiresAt: "2026-11-01T20:00:00.000Z",
        lastSeenAt: now,
        state: "active",
      },
    },
  });
  insertLegacyRow(connection, {
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    aggregateType: "chat-thread",
    aggregateId: chatThreadId,
    eventName: "chat.thread-created@1",
    payload: {
      kind: "thread-created",
      thread: {
        id: chatThreadId,
        title: "Provider-neutral Chat",
        lifecycle: "active",
        providerInstanceId: chatProviderId,
        modelId: "model-a",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm, direct, and useful.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  insertLegacyRow(connection, {
    eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    aggregateType: "code-thread",
    aggregateId: codeThreadId,
    eventName: "code.thread-created@1",
    payload: {
      kind: "thread-created",
      thread: {
        id: codeThreadId,
        projectId: "82000000-0000-4000-8000-000000000002",
        bindingRevisionId: "82000000-0000-4000-8000-000000000003",
        repositoryId: `repo_${"a".repeat(64)}`,
        checkoutId: "82000000-0000-4000-8000-000000000004",
        title: "Code thread",
        lifecycle: "active",
        providerInstanceId: "82000000-0000-4000-8000-000000000005",
        modelId: "model-a",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: "feature/code",
          remoteName: "origin",
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: "development",
          confirmedAt: now,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  insertLegacyRow(connection, {
    eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    aggregateType: "work-thread",
    aggregateId: workThreadId,
    eventName: "work.thread-created@1",
    payload: {
      kind: "thread-created",
      thread: {
        id: workThreadId,
        projectId: "83000000-0000-4000-8000-000000000002",
        title: "Work thread",
        lifecycle: "active",
        providerInstanceId: "83000000-0000-4000-8000-000000000003",
        modelId: "model-a",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  insertLegacyRow(connection, {
    eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    aggregateType: "window-workspace",
    aggregateId: windowId,
    eventName: "workspace.layout-replaced",
    payload: legacyWorkspaceLayoutPayload(legacyHostId),
  });
}

function rebuildRemoteAccessProjection(connection: SqliteConnection): void {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const projection = runtime.projections.get("remote-access");
  if (!(projection instanceof RemoteAccessProjection)) {
    throw new Error("remote-access projection is not registered");
  }
  rebuildProjections({ connection, journal, projections: [projection], clock: () => now });
}

/**
 * Rebuild the full runtime projection set (not just remote-access) from the
 * migrated journal, so every migrated payload — Chat/Work/Code threads and the
 * host-bearing workspace layout — is replayed through the projections a real
 * upgrade rebuilds.
 */
function rebuildAllProjections(connection: SqliteConnection): void {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  rebuildProjections({
    connection,
    journal,
    projections: runtime.projections.all(),
    clock: () => now,
  });
}

function readLayoutPayload(connection: SqliteConnection): string {
  return (
    connection
      .prepare("SELECT payload_json FROM event_journal WHERE event_name = ?")
      .get("workspace.layout-replaced") as { payload_json: string }
  ).payload_json;
}

describe("remote native exit evidence: migration and projection rebuild", () => {
  it("M1 initializes a fresh host identity before any event is appended", async () => {
    const connection = freshStore("octant-568-fresh-");
    await expect(
      initializeFreshHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
      }),
    ).resolves.toEqual({ hostId: stableHostId, keyFingerprint });
    expect(readHostIdentity(connection)).toMatchObject({
      host_id: stableHostId,
      key_fingerprint: keyFingerprint,
      key_generation: 1,
    });
    connection.close();
  });

  it("M1 refuses fresh initialization once the journal already holds events", async () => {
    const connection = freshStore("octant-568-fresh-populated-");
    seedPopulatedLegacyStore(connection);
    await expect(
      initializeFreshHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("M2 migrates a populated legacy store and rebuilds the remote-access projection under the stable id", async () => {
    const connection = freshStore("octant-568-populated-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).resolves.toEqual({ hostId: stableHostId, keyFingerprint });

    const journalHosts = connection
      .prepare("SELECT DISTINCT host_id FROM event_journal ORDER BY host_id")
      .all();
    expect(journalHosts).toEqual([{ host_id: stableHostId }]);

    const migratedDevice = JSON.parse(
      (
        connection
          .prepare("SELECT payload_json FROM event_journal WHERE event_name = ?")
          .get("remote.device-registered@1") as { payload_json: string }
      ).payload_json,
    ) as { device: { hostId: string } };
    expect(migratedDevice.device.hostId).toBe(stableHostId);

    // The embedded-host layout transform rewrote every `local` reference to the
    // stable host id; a transform that left `local` behind would surface here.
    const layoutJson = readLayoutPayload(connection);
    const migratedLayout = JSON.parse(layoutJson) as {
      workspace: { contextByMode: { chat: { host: string } } };
    };
    expect(migratedLayout.workspace.contextByMode.chat.host).toBe(stableHostId);
    expect(layoutJson).not.toContain('"host":"local"');

    // Rebuild the full runtime projection set — not only remote-access — so every
    // migrated Chat/Work/Code/layout payload is replayed the way a real upgrade
    // reprojects the store.
    rebuildAllProjections(connection);

    expect(readHostIdentity(connection)).toMatchObject({ host_id: stableHostId });
    const devices = readDeviceRegistrations(connection);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      device_id: deviceId,
      host_id: stableHostId,
      state: "active",
    });
    expect(
      connection.prepare("SELECT count(*) AS count FROM chat_thread_projection").get(),
    ).toEqual({ count: 1 });
    expect(
      connection.prepare("SELECT count(*) AS count FROM code_thread_projection").get(),
    ).toEqual({ count: 1 });
    connection.close();
  });

  it("M3 rolls back atomically on an injected interruption, then a restart completes the migration idempotently", async () => {
    const connection = freshStore("octant-568-interrupt-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();
    const before = connection
      .prepare("SELECT event_id, host_id, payload_json FROM event_journal ORDER BY global_sequence")
      .all();

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
        beforeCommit: () => {
          throw new Error("injected power loss mid-migration");
        },
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);

    expect(
      connection
        .prepare(
          "SELECT event_id, host_id, payload_json FROM event_journal ORDER BY global_sequence",
        )
        .all(),
    ).toEqual(before);
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).resolves.toEqual({ hostId: stableHostId, keyFingerprint });
    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).resolves.toEqual({ hostId: stableHostId, keyFingerprint });
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 1 });

    rebuildRemoteAccessProjection(connection);
    expect(readDeviceRegistrations(connection)).toHaveLength(1);
    connection.close();
  });

  it("M4 boots a migrated legacy store through the real persistence startup path", async () => {
    // Reachable-runtime-path evidence: after the migration runs through the real
    // runtime registry, the migrated on-disk store is loaded by the production
    // persistence startup (`makePersistenceLive` → `acquirePersistence`), which
    // runs the same schema migration, compatibility check, and full projection
    // catch-up a real upgrade performs. A store the migration corrupted would
    // fail this startup or replay, rather than passing a disconnected helper.
    const directory = mkdtempSync(join(tmpdir(), "octant-568-startup-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");

    const seed = openSqlite(databasePath);
    applyMigrations(seed, MIGRATIONS, () => now);
    seedPopulatedLegacyStore(seed);
    const runtime = createPhase1RuntimeRegistries();
    await migrateLegacyHostIdentity({
      connection: seed,
      keyStore,
      hostId: stableHostId,
      displayName: "This Mac",
      clock: () => now,
      registry: runtime.hostIdentityMigrations,
    });
    seed.close();

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          const connection = persistence.connection;
          return {
            status: persistence.status(),
            journalHosts: connection
              .prepare("SELECT DISTINCT host_id FROM event_journal ORDER BY host_id")
              .all(),
            hostIdentity: readHostIdentity(connection),
            devices: readDeviceRegistrations(connection),
            chatThreads: persistence.readChatThreads().length,
            codeThreads: persistence.readCodeThreads().length,
            layoutJson: readLayoutPayload(connection),
          };
        }).pipe(
          Effect.provide(makePersistenceLive({ dataDirectory: directory, clock: () => now })),
        ),
      ),
    );

    expect(observed.status).toMatchObject({
      state: "current",
      integrity: "ok",
      quarantineCount: 0,
    });
    for (const projection of observed.status.projections) {
      expect(projection.lag).toBe(0);
    }
    expect(observed.journalHosts).toEqual([{ host_id: stableHostId }]);
    expect(observed.hostIdentity).toMatchObject({ host_id: stableHostId });
    expect(observed.devices).toHaveLength(1);
    expect(observed.devices[0]).toMatchObject({ device_id: deviceId, host_id: stableHostId });
    expect(observed.chatThreads).toBe(1);
    expect(observed.codeThreads).toBe(1);
    expect(observed.layoutJson).not.toContain('"host":"local"');
    expect(observed.layoutJson).toContain(stableHostId);
  });

  it("K1 fails closed and mutates nothing when the Keychain identity is unavailable", async () => {
    const connection = freshStore("octant-568-keychain-unavailable-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();
    const unavailableKeyStore: HostIdentityKeyStore = {
      ensureKey: async () => {
        throw new Error("private-value raw keychain diagnostic");
      },
    };

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore: unavailableKeyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);

    expect(connection.prepare("SELECT DISTINCT host_id FROM event_journal").all()).toEqual([
      { host_id: legacyHostId },
    ]);
    expect(
      connection.prepare("SELECT count(*) AS count FROM host_identity_projection").get(),
    ).toEqual({ count: 0 });
    connection.close();
  });

  it("K2 does not leak the raw Keychain diagnostic through the fail-closed error", async () => {
    const connection = freshStore("octant-568-keychain-redaction-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();
    const diagnostic = "private-value raw keychain diagnostic";
    const failure = await migrateLegacyHostIdentity({
      connection,
      keyStore: {
        ensureKey: async () => {
          throw new Error(diagnostic);
        },
      },
      hostId: stableHostId,
      displayName: "This Mac",
      clock: () => now,
      registry: runtime.hostIdentityMigrations,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HostIdentityMigrationFailed);
    expect(String((failure as Error).message)).not.toContain("private-value");
    expect(String((failure as Error).message)).toBe("Octant host identity recovery is required.");
    connection.close();
  });

  it("K3 rejects a cloned store whose persisted host key does not match the recovered key", async () => {
    const connection = freshStore("octant-568-cloned-no-key-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();
    connection
      .prepare(
        "INSERT INTO host_identity_projection (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at) VALUES ('host', ?, ?, ?, 1, ?)",
      )
      .run(
        decodeStableHostId("99999999-9999-4999-8999-999999999999"),
        "Another Mac",
        "c".repeat(64),
        now,
      );

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT DISTINCT host_id FROM event_journal").all()).toEqual([
      { host_id: legacyHostId },
    ]);
    connection.close();
  });

  it("K3 rejects a fingerprint that is not a valid 64-hex host key", async () => {
    const connection = freshStore("octant-568-bad-fingerprint-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore: { ensureKey: async () => ({ fingerprint: "not-a-fingerprint" }) },
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT DISTINCT host_id FROM event_journal").all()).toEqual([
      { host_id: legacyHostId },
    ]);
    connection.close();
  });

  it("K3 refuses an unstable target host id without touching the store", async () => {
    const connection = freshStore("octant-568-unstable-id-");
    seedPopulatedLegacyStore(connection);
    const runtime = createPhase1RuntimeRegistries();

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: "local",
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(connection.prepare("SELECT DISTINCT host_id FROM event_journal").all()).toEqual([
      { host_id: legacyHostId },
    ]);
    connection.close();
  });

  it("K4 fails closed for a legacy event without a registered transform, leaving the store untouched", async () => {
    const connection = freshStore("octant-568-unknown-event-");
    seedPopulatedLegacyStore(connection);
    insertLegacyRow(connection, {
      eventId: "77777777-7777-4777-8777-777777777777",
      aggregateType: "fixture",
      aggregateId: "88888888-8888-4888-8888-888888888888",
      eventName: "fixture.unmapped-legacy-event@1",
      payload: { hostId: legacyHostId, value: "keep" },
    });
    const runtime = createPhase1RuntimeRegistries();
    const before = connection
      .prepare("SELECT event_id, host_id, payload_json FROM event_journal ORDER BY global_sequence")
      .all();

    await expect(
      migrateLegacyHostIdentity({
        connection,
        keyStore,
        hostId: stableHostId,
        displayName: "This Mac",
        clock: () => now,
        registry: runtime.hostIdentityMigrations,
      }),
    ).rejects.toBeInstanceOf(HostIdentityMigrationFailed);
    expect(
      connection
        .prepare(
          "SELECT event_id, host_id, payload_json FROM event_journal ORDER BY global_sequence",
        )
        .all(),
    ).toEqual(before);
    connection.close();
  });
});
