import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialPurgeAttempt } from "@octant/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialCleanupBlocked,
  DataLifecycleOperationFailed,
  PathOutsideDataDirectory,
} from "./dataLifecycleErrors";
import {
  deleteRemoteHostData,
  removeAllLocalDataWithCredentialPurge,
  previewLocalDataRemoval,
  removeAllLocalData,
  resetStore,
} from "./dataLifecycle";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { openSqlite, type SqliteConnection } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-13T10:00:00.000Z";
const fingerprint = "a".repeat(64);

function temporaryStore(): { readonly directory: string; readonly databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "octant-data-lifecycle-"));
  directories.push(directory);
  return { directory, databasePath: join(directory, "octant.sqlite3") };
}

function migratedConnection(databasePath: string): SqliteConnection {
  const connection = openSqlite(databasePath);
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

function seedEvent(connection: SqliteConnection, marker: string): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, 'fixture', ?, 1, 'fixture.recorded', 1, ?, NULL, 'system', ?, ?, ?)
    `)
    .run(
      `11111111-1111-4111-8111-${marker.padStart(12, "0")}`,
      `22222222-2222-4222-8222-${marker.padStart(12, "0")}`,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      now,
      JSON.stringify({ value: marker }),
    );
  connection
    .prepare(
      "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES ('fixture', ?, 1, (SELECT max(global_sequence) FROM event_journal))",
    )
    .run(`22222222-2222-4222-8222-${marker.padStart(12, "0")}`);
}

function seedHostScopedEvent(connection: SqliteConnection, marker: string, hostId: string): void {
  connection
    .prepare(`
      INSERT INTO event_journal (
        event_id, aggregate_type, aggregate_id, aggregate_version,
        event_name, event_version, host_id, correlation_id, causation_id,
        actor_kind, actor_id, occurred_at, payload_json
      ) VALUES (?, 'remote-host', ?, 1, 'fixture.recorded', 1, ?, ?, NULL, 'system', ?, ?, ?)
    `)
    .run(
      `55555555-5555-4555-8555-${marker.padStart(12, "0")}`,
      `66666666-6666-4666-8666-${marker.padStart(12, "0")}`,
      hostId,
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      now,
      JSON.stringify({ value: marker }),
    );
  connection
    .prepare(
      "INSERT INTO aggregate_heads (aggregate_type, aggregate_id, aggregate_version, last_sequence) VALUES ('remote-host', ?, 1, (SELECT max(global_sequence) FROM event_journal))",
    )
    .run(`66666666-6666-4666-8666-${marker.padStart(12, "0")}`);
}

function seedHostIdentity(connection: SqliteConnection): void {
  connection
    .prepare(`
      INSERT INTO host_identity_projection (
        identity_key, host_id, display_name, key_fingerprint, key_generation, created_at
      ) VALUES ('host', 'local', 'This Mac', ?, 1, ?)
    `)
    .run(fingerprint, now);
}

function seedRemoteDevice(connection: SqliteConnection, hostId: string, deviceId: string): void {
  connection
    .prepare(`
      INSERT INTO remote_device_projection (
        device_id, host_id, device_key_fingerprint, device_public_key, device_label,
        origin, protocol_floor, credential_generation, created_at, expires_at,
        last_seen_at, state
      ) VALUES (?, ?, ?, 'public-key', 'Device', 'lan-private', 1, 1, ?, ?, ?, 'active')
    `)
    .run(deviceId, hostId, fingerprint, now, now, now);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resetStore", () => {
  it("clears journal and projections but preserves host identity and schema, idempotently", () => {
    const { databasePath } = temporaryStore();
    const connection = migratedConnection(databasePath);
    seedHostIdentity(connection);
    seedEvent(connection, "1");
    seedEvent(connection, "2");

    const report = resetStore({ connection });

    expect(report.operation).toBe("reset");
    expect(report.retained).toContain("host-identity");
    expect(report.deleted).toContain("event-journal");
    expect(
      (connection.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(0);
    expect(
      (connection.prepare("SELECT count(*) AS c FROM aggregate_heads").get() as { c: number }).c,
    ).toBe(0);
    expect(
      (
        connection.prepare("SELECT host_id FROM host_identity_projection").get() as {
          host_id: string;
        }
      ).host_id,
    ).toBe("local");
    expect(
      (
        connection.prepare("SELECT coalesce(max(version),0) AS v FROM schema_migrations").get() as {
          v: number;
        }
      ).v,
    ).toBe(MIGRATIONS.at(-1)!.version);
    expect(connection.pragma("integrity_check", { simple: true })).toBe("ok");

    // Idempotent: a second reset makes no further change and stays consistent.
    const second = resetStore({ connection });
    expect(second.clearedTableCount).toBe(report.clearedTableCount);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    connection.close();
  });
});

describe("deleteRemoteHostData", () => {
  it("removes one remote host's credentials while leaving other hosts and the local journal intact", () => {
    const { databasePath } = temporaryStore();
    const connection = migratedConnection(databasePath);
    seedHostIdentity(connection);
    seedEvent(connection, "1");
    seedRemoteDevice(connection, "remote-a", "device-a");
    seedRemoteDevice(connection, "remote-b", "device-b");

    const report = deleteRemoteHostData({ connection, hostId: "remote-a", platform: "linux" });

    expect(report.deletedRowCount).toBeGreaterThanOrEqual(1);
    expect(report.credentialCleanup.performed).toBe(false);
    expect(
      connection.prepare("SELECT host_id FROM remote_device_projection ORDER BY host_id").all(),
    ).toEqual([{ host_id: "remote-b" }]);
    // The local host's journal is untouched by a selective remote deletion.
    expect(
      (connection.prepare("SELECT count(*) AS c FROM event_journal").get() as { c: number }).c,
    ).toBe(1);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    connection.close();
  });

  it("removes the remote host's journal events so a rebuild cannot resurrect it", () => {
    const { databasePath } = temporaryStore();
    const connection = migratedConnection(databasePath);
    seedHostIdentity(connection);
    seedEvent(connection, "1");
    seedHostScopedEvent(connection, "2", "remote-a");
    seedHostScopedEvent(connection, "3", "remote-b");
    seedRemoteDevice(connection, "remote-a", "device-a");
    seedRemoteDevice(connection, "remote-b", "device-b");

    deleteRemoteHostData({ connection, hostId: "remote-a", platform: "linux" });

    // The removed host's journal events are gone; the local journal and other
    // hosts' events survive, so a replay-based rebuild has nothing to resurrect.
    expect(connection.prepare("SELECT host_id FROM event_journal ORDER BY host_id").all()).toEqual([
      { host_id: "local" },
      { host_id: "remote-b" },
    ]);
    // No aggregate head is orphaned and no checkpoint is left ahead of the head.
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(
      connection
        .prepare(
          "SELECT count(*) AS c FROM aggregate_heads WHERE NOT EXISTS (SELECT 1 FROM event_journal j WHERE j.aggregate_type = aggregate_heads.aggregate_type AND j.aggregate_id = aggregate_heads.aggregate_id)",
        )
        .get(),
    ).toEqual({ c: 0 });
    connection.close();
  });

  it("refuses to selectively delete the local host", () => {
    const { databasePath } = temporaryStore();
    const connection = migratedConnection(databasePath);
    seedHostIdentity(connection);

    expect(() => deleteRemoteHostData({ connection, hostId: "local", platform: "darwin" })).toThrow(
      DataLifecycleOperationFailed,
    );
    connection.close();
  });
});

describe("removeAllLocalData", () => {
  it("removes every store artifact in the data directory and names the keychain residual when no host broker is available", () => {
    const { directory, databasePath } = temporaryStore();
    const connection = migratedConnection(databasePath);
    seedHostIdentity(connection);
    seedEvent(connection, "1");
    connection.close();
    writeFileSync(`${databasePath}.backup-pre-migration`, "leftover");
    const unrelated = join(directory, "keep-me.txt");
    writeFileSync(unrelated, "unrelated user file");

    const report = removeAllLocalData({
      dataDirectory: directory,
      databasePath,
      platform: "linux",
    });

    expect(report.operation).toBe("remove-all");
    expect(report.deleted).toContain("host-identity");
    expect(report.retained).toContain("external-repositories");
    expect(report.credentialCleanup.status).toBe("not-integrated");
    expect(report.credentialCleanup.performed).toBe(false);
    expect(report.credentialCleanup.residualReason).toContain("keychain");
    expect(report.removedArtifacts).toContain("octant.sqlite3");
    expect(report.removedArtifacts).toContain("octant.sqlite3.backup-pre-migration");
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(`${databasePath}.backup-pre-migration`)).toBe(false);
    // A non-store file in the same directory is left alone.
    expect(existsSync(unrelated)).toBe(true);
  });

  it("blocks macOS removal when no credential broker attempt is available", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();

    expect(() =>
      removeAllLocalData({
        dataDirectory: directory,
        databasePath,
        platform: "darwin",
      }),
    ).toThrow(CredentialCleanupBlocked);
    expect(existsSync(databasePath)).toBe(true);
  });

  it("refuses to remove a store outside its data directory", () => {
    const { directory } = temporaryStore();
    expect(() =>
      removeAllLocalData({
        dataDirectory: directory,
        databasePath: join(tmpdir(), "escape", "octant.sqlite3"),
        platform: "linux",
      }),
    ).toThrow(PathOutsideDataDirectory);
  });

  it("deletes local files only after a full Keychain purge completes", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const credentialPurgeAttempt: CredentialPurgeAttempt = { kind: "completed", deletedCount: 2 };

    const report = removeAllLocalData({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurgeAttempt,
    });

    expect(report.credentialCleanup).toMatchObject({
      status: "completed",
      performed: true,
      deletedCount: 2,
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each([
    ["locked", { kind: "locked" } satisfies CredentialPurgeAttempt, "locked"],
    ["unavailable", { kind: "unavailable" } satisfies CredentialPurgeAttempt, "unavailable"],
    [
      "partially failing",
      { kind: "partial", deletedCount: 1, failedCount: 1 } satisfies CredentialPurgeAttempt,
      "partial",
    ],
    ["failed", { kind: "failed" } satisfies CredentialPurgeAttempt, "failed"],
  ])(
    "fails closed and deletes nothing when the Keychain purge is %s",
    (_name, credentialPurgeAttempt, status) => {
      const { directory, databasePath } = temporaryStore();
      migratedConnection(databasePath).close();

      expect(() =>
        removeAllLocalData({
          dataDirectory: directory,
          databasePath,
          platform: "darwin",
          credentialPurgeAttempt,
        }),
      ).toThrow(CredentialCleanupBlocked);
      try {
        removeAllLocalData({
          dataDirectory: directory,
          databasePath,
          platform: "darwin",
          credentialPurgeAttempt,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialCleanupBlocked);
        expect((error as CredentialCleanupBlocked).status).toBe(status);
        expect((error as CredentialCleanupBlocked).recoveryGuidance).not.toContain(databasePath);
      }
      // Nothing was deleted: the store file and its sidecars are untouched.
      expect(existsSync(databasePath)).toBe(true);
    },
  );

  it("keeps staged store files recoverable until a broker-backed credential purge completes", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const events: Array<string> = [];

    const report = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) => {
        events.push(
          dryRun ? "preflight" : existsSync(databasePath) ? "purge-before-store-removal" : "purge",
        );
        return dryRun
          ? { kind: "dry-run", matchedCount: 2 }
          : { kind: "completed", deletedCount: 2 };
      },
    });

    expect(events).toEqual(["preflight", "purge"]);
    expect(report.credentialCleanup.status).toBe("completed");
    expect(existsSync(databasePath)).toBe(false);
  });

  it("stages and removes only the private-listener host identity with the selected store", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const remoteDirectory = join(directory, "remote");
    mkdirSync(remoteDirectory);
    const hostId = join(remoteDirectory, "private-listener-host-id");
    const hostKey = join(remoteDirectory, "private-listener-host-key.pem");
    const unrelatedRemoteState = join(remoteDirectory, "keep-me.txt");
    writeFileSync(hostId, "55555555-5555-4555-8555-555555555555\n");
    writeFileSync(hostKey, "private-key");
    writeFileSync(unrelatedRemoteState, "must remain");

    const report = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) =>
        dryRun ? { kind: "dry-run", matchedCount: 2 } : { kind: "completed", deletedCount: 2 },
    });

    expect(report.removedArtifacts).toEqual([
      "octant.sqlite3",
      join("remote", "private-listener-host-id"),
      join("remote", "private-listener-host-key.pem"),
    ]);
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(hostId)).toBe(false);
    expect(existsSync(hostKey)).toBe(false);
    expect(existsSync(unrelatedRemoteState)).toBe(true);
  });

  it("keeps the private-listener host identity staged when Keychain reconciliation is indeterminate", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const remoteDirectory = join(directory, "remote");
    mkdirSync(remoteDirectory);
    const hostId = join(remoteDirectory, "private-listener-host-id");
    const hostKey = join(remoteDirectory, "private-listener-host-key.pem");
    writeFileSync(hostId, "55555555-5555-4555-8555-555555555555\n");
    writeFileSync(hostKey, "private-key");

    const error = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) =>
        dryRun ? { kind: "dry-run", matchedCount: 2 } : { kind: "indeterminate" },
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ name: "CredentialCleanupBlocked", status: "indeterminate" });
    const stagingDirectory = readdirSync(directory).find((entry) =>
      entry.startsWith(".octant-remove-"),
    );
    expect(stagingDirectory).toBeDefined();
    expect(
      existsSync(join(directory, stagingDirectory!, "remote", "private-listener-host-id")),
    ).toBe(true);
    expect(
      existsSync(join(directory, stagingDirectory!, "remote", "private-listener-host-key.pem")),
    ).toBe(true);
    expect(existsSync(hostId)).toBe(false);
    expect(existsSync(hostKey)).toBe(false);
  });

  it("passes only the selected store's provider identities to every purge attempt", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const providerInstanceIds = ["10000000-0000-4000-8000-000000000001"];
    const attempts: Array<{
      readonly dryRun: boolean;
      readonly providerInstanceIds: readonly string[];
    }> = [];

    await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      providerInstanceIds,
      credentialPurge: async (input) => {
        attempts.push(input);
        return input.dryRun
          ? { kind: "dry-run", matchedCount: 1 }
          : { kind: "completed", deletedCount: 1 };
      },
    });

    expect(attempts).toEqual([
      { dryRun: true, providerInstanceIds },
      { dryRun: false, providerInstanceIds },
    ]);
  });

  it("passes selected-store host identity evidence through preflight and reconciliation", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const hostIdentityFingerprint = "a".repeat(64);
    const attempts: Array<{
      readonly dryRun: boolean;
      readonly providerInstanceIds: readonly string[];
      readonly hostIdentityFingerprint?: string;
    }> = [];

    await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      hostIdentityFingerprint,
      credentialPurge: async (input) => {
        attempts.push(input);
        return input.dryRun
          ? { kind: "dry-run", matchedCount: 1 }
          : { kind: "completed", deletedCount: 1 };
      },
    });

    expect(attempts).toEqual([
      { dryRun: true, providerInstanceIds: [], hostIdentityFingerprint },
      { dryRun: false, providerInstanceIds: [], hostIdentityFingerprint },
    ]);
  });

  it.each([
    ["locked", { kind: "locked" } satisfies CredentialPurgeAttempt],
    ["unavailable", { kind: "unavailable" } satisfies CredentialPurgeAttempt],
    [
      "partial",
      { kind: "partial", deletedCount: 1, failedCount: 1 } satisfies CredentialPurgeAttempt,
    ],
    ["failed", { kind: "failed" } satisfies CredentialPurgeAttempt],
  ])(
    "restores every staged store artifact when the Keychain purge is %s",
    async (_name, outcome) => {
      const { directory, databasePath } = temporaryStore();
      migratedConnection(databasePath).close();
      const sidecar = `${databasePath}-wal`;
      writeFileSync(sidecar, "sidecar");

      await expect(
        removeAllLocalDataWithCredentialPurge({
          dataDirectory: directory,
          databasePath,
          platform: "darwin",
          credentialPurge: async ({ dryRun }) =>
            dryRun ? { kind: "dry-run", matchedCount: 2 } : outcome,
        }),
      ).rejects.toBeInstanceOf(CredentialCleanupBlocked);

      expect(existsSync(databasePath)).toBe(true);
      expect(existsSync(sidecar)).toBe(true);
    },
  );

  it("retries an indeterminate purge and discards staged files after reconciliation completes", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const purgeCalls: boolean[] = [];

    const report = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) => {
        purgeCalls.push(dryRun);
        return dryRun
          ? { kind: "dry-run", matchedCount: 1 }
          : purgeCalls.filter((call) => !call).length === 1
            ? { kind: "indeterminate" }
            : { kind: "completed", deletedCount: 1 };
      },
    });

    expect(purgeCalls).toEqual([true, false, false]);
    expect(report.credentialCleanup.status).toBe("completed");
    expect(existsSync(databasePath)).toBe(false);
    expect(readdirSync(directory).some((entry) => entry.startsWith(".octant-remove-"))).toBe(false);
  });

  it("keeps staged store files when an indeterminate purge cannot be reconciled", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const purgeCalls: boolean[] = [];

    const error = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) => {
        purgeCalls.push(dryRun);
        return dryRun ? { kind: "dry-run", matchedCount: 1 } : { kind: "indeterminate" };
      },
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ name: "CredentialCleanupBlocked", status: "indeterminate" });
    expect(purgeCalls).toEqual([true, false, false]);
    expect(existsSync(databasePath)).toBe(false);
    const stagingDirectory = readdirSync(directory).find((entry) =>
      entry.startsWith(".octant-remove-"),
    );
    expect(stagingDirectory).toBeTruthy();
    expect(existsSync(join(directory, stagingDirectory!, "octant.sqlite3"))).toBe(true);
  });

  it("reconciles a verified staging directory left by an interrupted previous removal", async () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const stagingDirectory = join(directory, ".octant-remove-interrupted");
    mkdirSync(stagingDirectory);
    renameSync(databasePath, join(stagingDirectory, "octant.sqlite3"));

    const report = await removeAllLocalDataWithCredentialPurge({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurge: async ({ dryRun }) =>
        dryRun ? { kind: "dry-run", matchedCount: 1 } : { kind: "completed", deletedCount: 1 },
    });

    expect(report.removedArtifacts).toEqual(["octant.sqlite3"]);
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(stagingDirectory)).toBe(false);
  });

  it.each(["locked", "unavailable"] as const)(
    "keeps a recovered staging directory quarantined when reconciliation is %s",
    async (outcome) => {
      const { directory, databasePath } = temporaryStore();
      migratedConnection(databasePath).close();
      const stagingDirectory = join(directory, ".octant-remove-interrupted");
      mkdirSync(stagingDirectory);
      renameSync(databasePath, join(stagingDirectory, "octant.sqlite3"));

      const error = await removeAllLocalDataWithCredentialPurge({
        dataDirectory: directory,
        databasePath,
        platform: "darwin",
        credentialPurge: async ({ dryRun }) =>
          dryRun ? { kind: "dry-run", matchedCount: 0 } : { kind: outcome },
      }).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        name: "CredentialCleanupBlocked",
        status: "indeterminate",
      });
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(join(stagingDirectory, "octant.sqlite3"))).toBe(true);
    },
  );

  it("refuses a matching directory before calling the destructive Keychain purge", async () => {
    const { directory, databasePath } = temporaryStore();
    mkdirSync(databasePath);
    const nestedFile = join(databasePath, "unrelated-user-file.txt");
    writeFileSync(nestedFile, "must stay intact");
    const purgeCalls: Array<boolean> = [];

    await expect(
      removeAllLocalDataWithCredentialPurge({
        dataDirectory: directory,
        databasePath,
        platform: "darwin",
        credentialPurge: async ({ dryRun }) => {
          purgeCalls.push(dryRun);
          return dryRun
            ? { kind: "dry-run", matchedCount: 0 }
            : { kind: "completed", deletedCount: 0 };
        },
      }),
    ).rejects.toBeInstanceOf(DataLifecycleOperationFailed);

    expect(purgeCalls).toEqual([true]);
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(nestedFile)).toBe(true);
  });
});

describe("previewLocalDataRemoval", () => {
  it("lists what would be removed without deleting anything", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const unrelated = join(directory, "keep-me.txt");
    writeFileSync(unrelated, "unrelated user file");

    const preview = previewLocalDataRemoval({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.wouldRemoveArtifacts).toContain("octant.sqlite3");
    expect(preview.wouldRemoveArtifacts).not.toContain("keep-me.txt");
    expect(preview.credentialCleanup.status).toBe("not-integrated");
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("includes a verified interrupted staging directory in the exact preview inventory", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const stagingDirectory = join(directory, ".octant-remove-interrupted");
    mkdirSync(stagingDirectory);
    renameSync(databasePath, join(stagingDirectory, "octant.sqlite3"));

    const preview = previewLocalDataRemoval({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
    });

    expect(preview.wouldRemoveArtifacts).toEqual(["octant.sqlite3"]);
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(stagingDirectory, "octant.sqlite3"))).toBe(true);
  });

  it("reports a real dry-run Keychain match count without deleting credentials or files", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();
    const credentialPurgeAttempt: CredentialPurgeAttempt = { kind: "dry-run", matchedCount: 4 };

    const preview = previewLocalDataRemoval({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurgeAttempt,
    });

    expect(preview.credentialCleanup).toMatchObject({
      status: "dry-run",
      performed: false,
      matchedCount: 4,
    });
    expect(existsSync(databasePath)).toBe(true);
  });

  it.each(["directory", "symlink"] as const)(
    "refuses a %s that the confirmed removal would also refuse",
    (kind) => {
      const { directory, databasePath } = temporaryStore();
      if (kind === "directory") {
        mkdirSync(databasePath);
      } else {
        const target = join(directory, "unrelated-user-file.txt");
        writeFileSync(target, "must remain intact");
        symlinkSync(target, databasePath);
      }

      expect(() =>
        previewLocalDataRemoval({
          dataDirectory: directory,
          databasePath,
          platform: "darwin",
        }),
      ).toThrow(DataLifecycleOperationFailed);
    },
  );

  it("surfaces a locked or unavailable Keychain in the preview instead of throwing", () => {
    const { directory, databasePath } = temporaryStore();
    migratedConnection(databasePath).close();

    const preview = previewLocalDataRemoval({
      dataDirectory: directory,
      databasePath,
      platform: "darwin",
      credentialPurgeAttempt: { kind: "locked" },
    });

    expect(preview.credentialCleanup.status).toBe("locked");
    expect(preview.credentialCleanup.recoveryGuidance).toBeTruthy();
    expect(existsSync(databasePath)).toBe(true);
  });

  it("refuses to preview a store outside its data directory", () => {
    const { directory } = temporaryStore();
    expect(() =>
      previewLocalDataRemoval({
        dataDirectory: directory,
        databasePath: join(tmpdir(), "escape", "octant.sqlite3"),
        platform: "linux",
      }),
    ).toThrow(PathOutsideDataDirectory);
  });
});
