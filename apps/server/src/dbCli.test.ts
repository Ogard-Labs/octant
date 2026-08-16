import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDatabaseCommand,
  readCredentialPurgeIdentifiersForRemoval,
  readProviderInstanceIdsForRemoval,
  resolveCredentialPurgeAttempt,
  runDatabaseCommand,
  type DatabaseCommandServices,
} from "./dbCli";
import {
  CredentialCleanupBlocked,
  DataLifecycleOperationFailed,
  StoreBackupFailed,
} from "./persistence/dataLifecycleErrors";
import { MIGRATIONS } from "./persistence/migrations";
import { ProjectionStorageFailed } from "./persistence/projection";
import { openSqlite } from "./persistence/sqlitePort";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const status = {
  migrationVersion: 1,
  journalHead: 0,
  aggregateCount: 0,
  projections: [{ name: "aggregate-heads", lastSequence: 0, lag: 0 }],
  quarantineCount: 0,
  integrity: "ok" as const,
  state: "current" as const,
};

const backupReceipt = {
  migrationVersion: MIGRATIONS.at(-1)!.version,
  journalHead: 3,
  byteLength: 4096,
};
const resetReport = {
  operation: "reset" as const,
  retained: ["host-identity" as const, "store-schema" as const],
  deleted: ["event-journal" as const, "projections" as const],
  clearedTableCount: 12,
};
const removeReport = {
  operation: "remove-all" as const,
  retained: ["external-repositories" as const],
  deleted: ["store-files" as const, "host-identity" as const],
  credentialCleanup: {
    store: "os-keychain" as const,
    performed: false as const,
    status: "not-integrated" as const,
    deletedCount: 0,
    matchedCount: 0,
    residualReason: "requires native host",
    recoveryGuidance: null,
  },
  removedArtifacts: ["octant.sqlite3"],
};

const removePreviewReport = {
  operation: "remove-all" as const,
  dryRun: true as const,
  retained: ["external-repositories" as const],
  deleted: ["store-files" as const, "host-identity" as const],
  credentialCleanup: {
    store: "os-keychain" as const,
    performed: false as const,
    status: "dry-run" as const,
    deletedCount: 0,
    matchedCount: 2,
    residualReason: null,
    recoveryGuidance: null,
  },
  wouldRemoveArtifacts: ["octant.sqlite3"],
};

function services(): DatabaseCommandServices {
  return {
    status: () => status,
    verify: () => ({
      valid: true,
      state: "current",
      integrity: "ok",
      issues: [],
    }),
    rebuildAll: () => ({ rebuilt: ["aggregate-heads"], journalHead: 0 }),
    rebuildProjection: (projectionName) => ({
      rebuilt: [projectionName],
      journalHead: 0,
    }),
    backup: () => backupReceipt,
    restore: () => backupReceipt,
    reset: () => resetReport,
    removeAll: () => removeReport,
    previewRemoveAll: () => removePreviewReport,
  };
}

describe("runDatabaseCommand", () => {
  it("reads provider identities from a private snapshot without changing the selected store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-db-cli-provider-ids-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    const connection = openSqlite(databasePath);
    connection.exec(
      "CREATE TABLE provider_instance_projection (instance_id TEXT NOT NULL); INSERT INTO provider_instance_projection (instance_id) VALUES ('10000000-0000-4000-8000-000000000001')",
    );
    connection.close();
    const before = await readdir(directory);

    expect(readProviderInstanceIdsForRemoval(databasePath)).toEqual([
      "10000000-0000-4000-8000-000000000001",
    ]);

    expect(await readdir(directory)).toEqual(before);
  });

  it("treats an absent pre-provider projection as an empty removal identity set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-db-cli-pre-provider-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    openSqlite(databasePath).close();

    expect(readProviderInstanceIdsForRemoval(databasePath)).toEqual([]);
  });

  it("recovers current provider identities from the journal when only the projection is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-db-cli-provider-journal-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    const connection = openSqlite(databasePath);
    connection.exec(`
      CREATE TABLE event_journal (
        global_sequence INTEGER NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        event_name TEXT NOT NULL
      );
      INSERT INTO event_journal VALUES
        (1, 'provider-instance', '10000000-0000-4000-8000-000000000001', 1, 'provider.instance-created@1'),
        (2, 'provider-instance', '10000000-0000-4000-8000-000000000002', 1, 'provider.instance-created@1'),
        (3, 'provider-instance', '10000000-0000-4000-8000-000000000002', 2, 'provider.instance-removed@1');
    `);
    connection.close();

    expect(readProviderInstanceIdsForRemoval(databasePath)).toEqual([
      "10000000-0000-4000-8000-000000000001",
    ]);
  });

  it("reads provider identities from the validated staged database during removal retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-db-cli-staged-provider-ids-"));
    directories.push(directory);
    const databasePath = join(directory, "octant.sqlite3");
    const connection = openSqlite(databasePath);
    connection.exec(
      "CREATE TABLE provider_instance_projection (instance_id TEXT NOT NULL); INSERT INTO provider_instance_projection (instance_id) VALUES ('10000000-0000-4000-8000-000000000002'); CREATE TABLE host_identity_projection (identity_key TEXT NOT NULL, key_fingerprint TEXT NOT NULL); INSERT INTO host_identity_projection (identity_key, key_fingerprint) VALUES ('host', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
    );
    connection.close();
    const stagingDirectory = join(directory, ".octant-remove-interrupted");
    await mkdir(stagingDirectory);
    await rename(databasePath, join(stagingDirectory, "octant.sqlite3"));

    expect(readCredentialPurgeIdentifiersForRemoval(databasePath, directory)).toEqual({
      providerInstanceIds: ["10000000-0000-4000-8000-000000000002"],
      hostIdentityFingerprint: "a".repeat(64),
    });
    expect(await readdir(stagingDirectory)).toEqual(["octant.sqlite3"]);
  });

  it("treats a missing macOS credential broker as an unavailable destructive boundary", async () => {
    await expect(
      resolveCredentialPurgeAttempt({
        platform: "darwin",
        dryRun: false,
        providerInstanceIds: [],
        env: {},
      }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("validates remove confirmation before any destructive operation can be requested", () => {
    expect(parseDatabaseCommand(["remove"])).toMatchObject({
      ok: false,
      message:
        "The remove operation is destructive; pass --confirm to proceed, or --dry-run to preview.",
    });
    expect(parseDatabaseCommand(["remove", "--confirm", "extra"])).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["status", ["status"], status],
    ["verify", ["verify"], { valid: true, state: "current", integrity: "ok", issues: [] }],
    ["rebuild", ["rebuild"], { rebuilt: ["aggregate-heads"], journalHead: 0 }],
    [
      "isolated rebuild",
      ["rebuild", "--projection", "aggregate-heads"],
      { rebuilt: ["aggregate-heads"], journalHead: 0 },
    ],
  ])("parses %s and returns pretty JSON", (_name, args, expected) => {
    const result = runDatabaseCommand(args, services());

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(expected, null, 2)}\n`,
      stderr: "",
    });
  });

  it.each([
    ["backup", ["backup"], backupReceipt],
    ["confirmed restore", ["restore", "--confirm"], backupReceipt],
    ["confirmed reset", ["reset", "--confirm"], resetReport],
    ["confirmed remove", ["remove", "--confirm"], removeReport],
    ["dry-run remove preview", ["remove", "--dry-run"], removePreviewReport],
  ])("parses %s and returns pretty JSON", (_name, args, expected) => {
    const result = runDatabaseCommand(args, services());

    expect(result).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(expected, null, 2)}\n`,
      stderr: "",
    });
  });

  it("calls only the preview service for a dry-run remove, never the destructive one", () => {
    const removeAll = () => {
      throw new Error("the destructive remove path must not run during a dry-run preview");
    };
    const result = runDatabaseCommand(["remove", "--dry-run"], {
      ...services(),
      removeAll,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(removePreviewReport);
  });

  it.each([
    [[], "Expected status, verify, rebuild, backup, restore, reset, or remove."],
    [["unknown"], "Unknown database command."],
    [["rebuild", "--projection"], "--projection requires a projection name."],
    [["rebuild", "--projection", "aggregate-heads", "extra"], "Unexpected arguments."],
    [["reset"], "The reset operation is destructive; pass --confirm to proceed."],
    [["restore"], "The restore operation is destructive; pass --confirm to proceed."],
    [["remove"], "The remove operation is destructive; pass --confirm to proceed, or --dry-run"],
    [
      ["remove", "--dry-run", "extra"],
      "The remove operation is destructive; pass --confirm to proceed, or --dry-run",
    ],
  ])("rejects invalid arguments with actionable redacted usage", (args, message) => {
    const result = runDatabaseCommand(args, services());

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage: bun run db:");
  });

  it.each([
    [
      "backup failure",
      () => {
        throw new StoreBackupFailed({ operation: "create" });
      },
      {
        category: "backup-failed",
        message: "Octant could not create a store backup.",
      },
    ],
    [
      "local-scope removal refusal",
      () => {
        throw new DataLifecycleOperationFailed({ operation: "reset" });
      },
      {
        category: "operation-failed",
        message: "The Octant data-lifecycle operation could not complete.",
      },
    ],
  ])("maps %s to a stable redacted category", (_name, backup, expected) => {
    const result = runDatabaseCommand(["backup"], { ...services(), backup });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`${JSON.stringify({ ok: false, error: expected }, null, 2)}\n`);
  });

  it.each([
    ["locked", "The macOS Keychain is locked or requires interaction. Retry."] as const,
    ["unavailable", "The macOS Keychain is unavailable. Retry."] as const,
    ["partial", "Some credentials could not be removed. Retry."] as const,
    [
      "indeterminate",
      "The Keychain cleanup outcome could not be confirmed. Reconcile before retrying.",
    ] as const,
    ["failed", "The Keychain purge failed. Retry."] as const,
  ])("maps a %s CredentialCleanupBlocked failure without raw diagnostics", (status, guidance) => {
    const result = runDatabaseCommand(["remove", "--confirm"], {
      ...services(),
      removeAll: () => {
        throw new CredentialCleanupBlocked({
          status,
          recoveryGuidance: guidance,
        });
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: { category: "credential-cleanup-blocked", message: guidance },
    });
  });

  it("maps operational failures to a stable category without raw error details", () => {
    const privateSentinel = "/private/store SELECT payload_json";
    const result = runDatabaseCommand(["status"], {
      ...services(),
      status: () => {
        throw Object.assign(new Error(privateSentinel), {
          code: "SQLITE_IOERR_READ",
        });
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            category: "storage-unavailable",
            message: "Octant storage is unavailable.",
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(result.stderr).not.toContain(privateSentinel);
  });

  it("uses a non-zero exit code when verification detects an invalid store", () => {
    const verification = {
      valid: false as const,
      state: "invalid" as const,
      integrity: "ok" as const,
      issues: [{ kind: "sqlite-integrity-check" as const }],
    };
    const result = runDatabaseCommand(["verify"], {
      ...services(),
      verify: () => verification,
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: `${JSON.stringify(verification, null, 2)}\n`,
      stderr: "",
    });
  });

  it.each([
    ["busy", "storage-busy", "Octant storage is busy; retry after other work stops."],
    ["unavailable", "storage-unavailable", "Octant storage is unavailable."],
  ] as const)(
    "maps typed projection storage category %s without raw details",
    (category, code, message) => {
      const result = runDatabaseCommand(["rebuild"], {
        ...services(),
        rebuildAll: () => {
          throw new ProjectionStorageFailed({
            projectionName: "aggregate-heads",
            operation: "rebuild",
            category,
          });
        },
      });

      expect(result).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `${JSON.stringify({ ok: false, error: { category: code, message } }, null, 2)}\n`,
      });
      expect(result.stderr).not.toContain("aggregate-heads");
    },
  );
});
