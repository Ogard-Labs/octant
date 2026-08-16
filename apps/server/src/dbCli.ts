import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireHostRuntimeOwner,
  deriveHostRuntimeHostId,
  HostRuntimeOwnershipError,
  prepareHostRuntimePaths,
  readHostRuntimeProcessStart,
  resolveHostRuntimePaths,
  type HostRuntimeAttachment,
  type HostRuntimeOwner,
} from "@octant/host-runtime";
import type { CredentialPurgeAttempt } from "@octant/domain";
import {
  BackupVerificationFailed,
  CredentialCleanupBlocked,
  DataLifecycleOperationFailed,
  MigrationDowngradeRefused,
  MigrationInterruptedRestored,
  PathOutsideDataDirectory,
  StoreBackupFailed,
  StoreRestoreFailed,
} from "./persistence/dataLifecycleErrors";
import {
  databasePathForPendingLocalDataRemoval,
  previewLocalDataRemoval,
  removeAllLocalData,
  removeAllLocalDataWithCredentialPurge,
  resetStore,
  type RemoveAllPreviewReport,
  type RemoveAllReport,
  type StoreResetReport,
} from "./persistence/dataLifecycle";
import { makeCredentialCleanupClient } from "./providers/credentialBrokerClient";
import { classifySqliteFailure } from "./persistence/journalErrors";
import { Journal } from "./persistence/journal";
import {
  DatabaseVersionTooNew,
  MigrationChecksumMismatch,
  MigrationFailed,
  MigrationHistoryMismatch,
} from "./persistence/migrationErrors";
import { migrateStoreWithBackup } from "./persistence/migrationBackup";
import { MIGRATIONS } from "./persistence/migrations";
import {
  IsolatedProjectionRebuildRejected,
  UnknownProjection,
  databaseStatus,
  rebuildAll,
  rebuildProjectionByName,
  verifyDatabase,
  type DatabaseStatus,
  type DatabaseVerification,
  type RebuildResult,
} from "./persistence/recovery";
import { ProjectionQuarantined, ProjectionStorageFailed } from "./persistence/projection";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import {
  backupPathFor,
  createStoreBackup,
  restoreStoreBackup,
  type StoreBackupReceipt,
} from "./persistence/storeBackup";

export interface DatabaseCommandServices {
  readonly status: () => DatabaseStatus;
  readonly verify: () => DatabaseVerification;
  readonly rebuildAll: () => RebuildResult;
  readonly rebuildProjection: (projectionName: string) => RebuildResult;
  readonly backup: () => StoreBackupReceipt;
  readonly restore: () => StoreBackupReceipt;
  readonly reset: () => StoreResetReport;
  readonly removeAll: () => RemoveAllReport;
  readonly previewRemoveAll: () => RemoveAllPreviewReport;
}

export interface DatabaseCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandOutput =
  | DatabaseStatus
  | DatabaseVerification
  | RebuildResult
  | StoreBackupReceipt
  | StoreResetReport
  | RemoveAllReport
  | RemoveAllPreviewReport;

const usage = [
  "Usage: bun run db:status",
  "       bun run db:verify",
  "       bun run db:rebuild -- --projection <name>",
  "       bun run db:backup",
  "       bun run db:restore -- --confirm",
  "       bun run db:reset -- --confirm",
  "       bun run db:remove -- --confirm",
  "       bun run db:remove -- --dry-run",
].join("\n");

export function runDatabaseCommand(
  args: ReadonlyArray<string>,
  services: DatabaseCommandServices,
): DatabaseCommandResult {
  const parsed = parseDatabaseCommand(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${usage}\n` };
  }

  try {
    let output: CommandOutput;
    let exitCode: 0 | 1 = 0;
    switch (parsed.command) {
      case "status":
        output = services.status();
        break;
      case "verify":
        output = services.verify();
        if (!output.valid) exitCode = 1;
        break;
      case "rebuild":
        output =
          parsed.projectionName === undefined
            ? services.rebuildAll()
            : services.rebuildProjection(parsed.projectionName);
        break;
      case "backup":
        output = services.backup();
        break;
      case "restore":
        output = services.restore();
        break;
      case "reset":
        output = services.reset();
        break;
      case "remove":
        output = parsed.dryRun ? services.previewRemoveAll() : services.removeAll();
        break;
    }
    return {
      exitCode,
      stdout: prettyJson(output),
      stderr: "",
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: prettyJson(redactOperationalError(error)),
    };
  }
}

export type ParsedCommand =
  | { readonly ok: true; readonly command: "status" }
  | { readonly ok: true; readonly command: "verify" }
  | {
      readonly ok: true;
      readonly command: "rebuild";
      readonly projectionName?: string;
    }
  | { readonly ok: true; readonly command: "backup" }
  | { readonly ok: true; readonly command: "restore" }
  | { readonly ok: true; readonly command: "reset" }
  | { readonly ok: true; readonly command: "remove"; readonly dryRun: boolean }
  | { readonly ok: false; readonly message: string };

export function parseDatabaseCommand(args: ReadonlyArray<string>): ParsedCommand {
  const command = args[0];
  if (command === undefined) {
    return {
      ok: false,
      message: "Expected status, verify, rebuild, backup, restore, reset, or remove.",
    };
  }
  if (command === "status" || command === "verify" || command === "backup") {
    return args.length === 1
      ? { ok: true, command }
      : { ok: false, message: "Unexpected arguments." };
  }
  if (command === "remove") {
    if (args.length !== 2 || (args[1] !== "--confirm" && args[1] !== "--dry-run")) {
      return {
        ok: false,
        message:
          "The remove operation is destructive; pass --confirm to proceed, or --dry-run to preview.",
      };
    }
    return { ok: true, command, dryRun: args[1] === "--dry-run" };
  }
  if (command === "restore" || command === "reset") {
    if (args.length !== 2 || args[1] !== "--confirm") {
      return {
        ok: false,
        message: `The ${command} operation is destructive; pass --confirm to proceed.`,
      };
    }
    return { ok: true, command };
  }
  if (command !== "rebuild") return { ok: false, message: "Unknown database command." };
  if (args.length === 1) return { ok: true, command: "rebuild" };
  if (args[1] !== "--projection") return { ok: false, message: "Unexpected arguments." };
  const projectionName = args[2];
  if (projectionName === undefined || projectionName.trim() === "") {
    return { ok: false, message: "--projection requires a projection name." };
  }
  if (args.length !== 3) return { ok: false, message: "Unexpected arguments." };
  return { ok: true, command: "rebuild", projectionName };
}

function requiresMigratedSchema(command: string | undefined): boolean {
  // Restore and remove are recovery paths that must run even against an
  // unmigrated or incompatible store, so they never force a migration first.
  return command !== "restore" && command !== "remove";
}

function redactOperationalError(error: unknown): {
  readonly ok: false;
  readonly error: { readonly category: string; readonly message: string };
} {
  if (error instanceof DatabaseOwnerActive) {
    return failure("owner-active", "Stop the active Octant host before running database commands.");
  }
  if (error instanceof HostRuntimeOwnershipError) {
    return failure("owner-unavailable", "Octant could not acquire exclusive database ownership.");
  }
  if (error instanceof UnknownProjection) {
    return failure("projection-not-found", "The requested Octant projection is not registered.");
  }
  if (error instanceof IsolatedProjectionRebuildRejected) {
    return failure(
      "isolated-rebuild-rejected",
      "Rebuild all projections because another projection depends on the requested projection.",
    );
  }
  if (error instanceof ProjectionQuarantined) {
    return failure(
      "recovery-required",
      "Octant stopped at a quarantined event; the journal was not changed.",
    );
  }
  if (error instanceof ProjectionStorageFailed) {
    return error.category === "busy"
      ? failure("storage-busy", "Octant storage is busy; retry after other work stops.")
      : failure("storage-unavailable", "Octant storage is unavailable.");
  }
  if (
    error instanceof MigrationChecksumMismatch ||
    error instanceof MigrationHistoryMismatch ||
    error instanceof DatabaseVersionTooNew ||
    error instanceof MigrationFailed ||
    error instanceof MigrationDowngradeRefused ||
    error instanceof MigrationInterruptedRestored
  ) {
    return failure("migration-incompatible", "Octant cannot use this database migration state.");
  }
  if (error instanceof StoreBackupFailed) {
    return failure("backup-failed", "Octant could not create a store backup.");
  }
  if (error instanceof BackupVerificationFailed) {
    return failure("backup-unverified", "The Octant backup could not be verified.");
  }
  if (error instanceof StoreRestoreFailed) {
    return failure("restore-failed", "Octant could not restore the store from a backup.");
  }
  if (error instanceof PathOutsideDataDirectory) {
    return failure("path-confined", "The requested path is outside the Octant data directory.");
  }
  if (error instanceof DataLifecycleOperationFailed) {
    return failure("operation-failed", "The Octant data-lifecycle operation could not complete.");
  }
  if (error instanceof CredentialCleanupBlocked) {
    return failure("credential-cleanup-blocked", error.recoveryGuidance);
  }
  const sqliteFailure = classifySqliteFailure(error);
  if (sqliteFailure === "write-race") {
    return failure("storage-busy", "Octant storage is busy; retry after other work stops.");
  }
  if (sqliteFailure === "storage") {
    return failure("storage-unavailable", "Octant storage is unavailable.");
  }
  return failure("operation-failed", "The Octant database command could not complete.");
}

function failure(category: string, message: string) {
  return { ok: false as const, error: { category, message } };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Resolves what a "remove" command's Keychain purge attempt would be, without
 * ever throwing: no broker on a non-macOS headless invocation reports the
 * honest `not-integrated` capability gap, but macOS must fail closed as
 * `unavailable` because its Keychain may still contain credentials. When a
 * broker is configured, this performs the real dry-run or destructive purge
 * through it before any local file is touched.
 */
export async function resolveCredentialPurgeAttempt(options: {
  readonly platform: string;
  readonly dryRun: boolean;
  readonly providerInstanceIds: readonly string[];
  readonly hostIdentityFingerprint?: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<CredentialPurgeAttempt> {
  if (options.platform !== "darwin") return { kind: "not-integrated" };
  const url = options.env.OCTANT_CREDENTIAL_BROKER_URL;
  const token = options.env.OCTANT_CREDENTIAL_BROKER_TOKEN;
  if (url === undefined || token === undefined) return { kind: "unavailable" };
  const client = makeCredentialCleanupClient({ url, token });
  return client.purge({
    dryRun: options.dryRun,
    providerInstanceIds: options.providerInstanceIds,
    ...(options.hostIdentityFingerprint === undefined
      ? {}
      : { hostIdentityFingerprint: options.hostIdentityFingerprint }),
  });
}

async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  const parsed = parseDatabaseCommand(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${usage}\n`);
    return 2;
  }
  const clock = () => new Date().toISOString();
  const platform = process.platform;
  let connection: SqliteConnection | undefined;
  let runtimeOwner: HostRuntimeOwner | undefined;
  let connectionClosed = false;
  const closeConnection = () => {
    if (connection !== undefined && !connectionClosed) {
      connection.close();
      connectionClosed = true;
    }
  };

  try {
    const paths = resolveHostRuntimePaths({
      env: process.env,
      platform,
      home: homedir(),
      temporaryDirectory: canonicalTemporaryDirectory(),
      uid: process.getuid?.() ?? 0,
    });
    await prepareHostRuntimePaths(paths);
    const ownership = await acquireHostRuntimeOwner({
      paths,
      hostId: deriveHostRuntimeHostId(paths.dataDirectory),
      instanceId: randomUUID(),
      serverVersion: process.env.npm_package_version ?? "0.0.0-dev",
      wireVersion: "1",
      serviceMode: "maintenance",
      processStart: await readHostRuntimeProcessStart(process.pid),
    });
    if (ownership.kind === "attached") {
      // Online operations route through the live owner instead of opening the
      // store from a second process. Everything else remains offline-only and
      // fails closed while an owner is active.
      const online = await runOnlineOwnerCommand(parsed, ownership);
      if (online === undefined) throw new DatabaseOwnerActive();
      if (online.stdout) process.stdout.write(online.stdout);
      if (online.stderr) process.stderr.write(online.stderr);
      return online.exitCode;
    }
    runtimeOwner = ownership;
    const dataDirectory = paths.dataDirectory;
    const databasePath = join(dataDirectory, "octant.sqlite3");

    if (parsed.command === "remove") {
      const credentialPurgeIdentifiers =
        platform === "darwin"
          ? readCredentialPurgeIdentifiersForRemoval(databasePath, dataDirectory)
          : { providerInstanceIds: [] };
      const output = parsed.dryRun
        ? previewLocalDataRemoval({
            dataDirectory,
            databasePath,
            platform,
            credentialPurgeAttempt: await resolveCredentialPurgeAttempt({
              platform,
              dryRun: true,
              providerInstanceIds: credentialPurgeIdentifiers.providerInstanceIds,
              ...(credentialPurgeIdentifiers.hostIdentityFingerprint === undefined
                ? {}
                : {
                    hostIdentityFingerprint: credentialPurgeIdentifiers.hostIdentityFingerprint,
                  }),
              env: process.env,
            }),
          })
        : await removeAllLocalDataWithCredentialPurge({
            dataDirectory,
            databasePath,
            platform,
            providerInstanceIds: credentialPurgeIdentifiers.providerInstanceIds,
            ...(credentialPurgeIdentifiers.hostIdentityFingerprint === undefined
              ? {}
              : {
                  hostIdentityFingerprint: credentialPurgeIdentifiers.hostIdentityFingerprint,
                }),
            credentialPurge: ({
              dryRun,
              providerInstanceIds: selectedProviderInstanceIds,
              hostIdentityFingerprint,
            }) =>
              resolveCredentialPurgeAttempt({
                platform,
                dryRun,
                providerInstanceIds: selectedProviderInstanceIds,
                ...(hostIdentityFingerprint === undefined ? {} : { hostIdentityFingerprint }),
                env: process.env,
              }),
          });
      process.stdout.write(prettyJson(output));
      return 0;
    }

    const manualBackupPath = backupPathFor(databasePath, "manual");

    if (requiresMigratedSchema(parsed.command)) {
      // Route CLI migrations through the atomic backup boundary rather than a
      // bare applyMigrations, so a multi-step upgrade triggered from the command
      // line is protected by a verified pre-migration snapshot and rolled back
      // to it if any step fails, instead of leaving a partially migrated store.
      connection = migrateStoreWithBackup({
        databasePath,
        dataDirectory,
        migrations: MIGRATIONS,
        clock,
      }).connection;
    } else {
      connection = openSqlite(databasePath);
    }
    const activeConnection = connection;

    let recoveryInput: ReturnType<typeof buildRecoveryInput> | undefined;
    const recovery = () => {
      recoveryInput ??= buildRecoveryInput(activeConnection, clock);
      return recoveryInput;
    };

    // Non-remove handlers stay synchronous and do not cross the credential boundary.
    const credentialPurgeAttempt: CredentialPurgeAttempt = {
      kind: "not-integrated",
    };

    const result = runDatabaseCommand(args, {
      status: () => databaseStatus(recovery()),
      verify: () => verifyDatabase(recovery()),
      rebuildAll: () => rebuildAll(recovery()),
      rebuildProjection: (projectionName) =>
        rebuildProjectionByName({ ...recovery(), projectionName }),
      backup: () =>
        createStoreBackup({
          connection: activeConnection,
          dataDirectory,
          backupPath: manualBackupPath,
        }),
      reset: () => resetStore({ connection: activeConnection }),
      restore: () => {
        closeConnection();
        return restoreStoreBackup({
          dataDirectory,
          databasePath,
          backupPath: manualBackupPath,
        });
      },
      removeAll: () => {
        closeConnection();
        return removeAllLocalData({
          dataDirectory,
          databasePath,
          platform,
          credentialPurgeAttempt,
        });
      },
      previewRemoveAll: () =>
        previewLocalDataRemoval({
          dataDirectory,
          databasePath,
          platform,
          credentialPurgeAttempt,
        }),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(prettyJson(redactOperationalError(error)));
    return 1;
  } finally {
    closeConnection();
    await runtimeOwner?.release();
  }
}

export interface CredentialPurgeIdentifiersForRemoval {
  readonly providerInstanceIds: readonly string[];
  readonly hostIdentityFingerprint?: string;
}

const PROVIDER_INSTANCE_SNAPSHOT_EVENTS = new Set([
  "provider.instance-created@1",
  "provider.instance-renamed@1",
  "provider.instance-binary-changed@1",
  "provider.instance-configuration-changed@1",
  "provider.instance-enabled-changed@1",
]);
const PROVIDER_INSTANCE_REMOVED_EVENT = "provider.instance-removed@1";
const PROVIDER_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readProviderInstanceIdsForRemoval(
  databasePath: string,
  dataDirectory = dirname(databasePath),
): readonly string[] {
  return readCredentialPurgeIdentifiersForRemoval(databasePath, dataDirectory).providerInstanceIds;
}

export function readCredentialPurgeIdentifiersForRemoval(
  databasePath: string,
  dataDirectory = dirname(databasePath),
): CredentialPurgeIdentifiersForRemoval {
  // Do not open a missing SQLite path. The normal runtime SQLite opener sets
  // permissions and WAL mode, so inspect a private snapshot instead: even a
  // dry-run must leave the selected store and its sidecars untouched.
  const selectedDatabasePath = databasePathForPendingLocalDataRemoval({
    dataDirectory,
    databasePath,
  });
  if (!existsSync(selectedDatabasePath)) return { providerInstanceIds: [] };
  const snapshotDirectory = mkdtempSync(
    join(canonicalTemporaryDirectory(), "octant-provider-ids-"),
  );
  const snapshotPath = join(snapshotDirectory, basename(selectedDatabasePath));
  let connection: SqliteConnection | undefined;
  try {
    copyFileSync(selectedDatabasePath, snapshotPath);
    const walPath = `${selectedDatabasePath}-wal`;
    if (existsSync(walPath)) copyFileSync(walPath, `${snapshotPath}-wal`);
    connection = openSqlite(snapshotPath);
    const hasProviderProjection = connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("provider_instance_projection");
    // `remove` intentionally bypasses migrations. An actually pre-provider
    // database has no provider projection or provider journal entries, but a
    // recovery database can lose only this rebuildable projection. In the
    // latter case the event journal remains authoritative for the selected
    // store's configured provider identities.
    const rows =
      hasProviderProjection === undefined
        ? providerInstanceRowsFromJournal(connection)
        : (connection
            .prepare("SELECT instance_id FROM provider_instance_projection ORDER BY instance_id")
            .all() as ReadonlyArray<{ readonly instance_id: unknown }>);
    const ids = rows.map((row) => row.instance_id);
    if (
      ids.some((id) => typeof id !== "string" || !PROVIDER_INSTANCE_ID_PATTERN.test(id)) ||
      new Set(ids).size !== ids.length
    ) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
    const hasHostIdentityProjection = connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("host_identity_projection");
    const hostIdentityRow =
      hasHostIdentityProjection === undefined
        ? undefined
        : (connection
            .prepare(
              "SELECT key_fingerprint FROM host_identity_projection WHERE identity_key = 'host'",
            )
            .get() as { readonly key_fingerprint: unknown } | undefined);
    if (hostIdentityRow === undefined) {
      return { providerInstanceIds: ids as readonly string[] };
    }
    if (
      typeof hostIdentityRow.key_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(hostIdentityRow.key_fingerprint)
    ) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
    return {
      providerInstanceIds: ids as readonly string[],
      hostIdentityFingerprint: hostIdentityRow.key_fingerprint,
    };
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  } finally {
    connection?.close();
    rmSync(snapshotDirectory, { force: true, recursive: true });
  }
}

/**
 * Rebuild the current provider identity set from journal metadata only. This
 * is intentionally narrow: an absent journal is a genuine pre-provider
 * schema, while malformed or unknown provider-instance history fails the
 * destructive operation closed rather than authorizing a partial purge.
 */
function providerInstanceRowsFromJournal(
  connection: SqliteConnection,
): ReadonlyArray<{ readonly instance_id: string }> {
  const hasJournal = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("event_journal");
  if (hasJournal === undefined) return [];
  const rows = connection
    .prepare(
      `SELECT aggregate_id, event_name
       FROM event_journal
       WHERE aggregate_type = 'provider-instance'
       ORDER BY aggregate_id ASC, aggregate_version DESC, global_sequence DESC`,
    )
    .all() as ReadonlyArray<{
    readonly aggregate_id: unknown;
    readonly event_name: unknown;
  }>;
  const active = new Set<string>();
  const observed = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.aggregate_id !== "string" ||
      !PROVIDER_INSTANCE_ID_PATTERN.test(row.aggregate_id) ||
      typeof row.event_name !== "string"
    ) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
    if (observed.has(row.aggregate_id)) continue;
    observed.add(row.aggregate_id);
    if (row.event_name === PROVIDER_INSTANCE_REMOVED_EVENT) continue;
    if (!PROVIDER_INSTANCE_SNAPSHOT_EVENTS.has(row.event_name)) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
    active.add(row.aggregate_id);
  }
  return [...active].sort().map((instance_id) => ({ instance_id }));
}

/**
 * Executes the commands that are legal against a live owner by routing them
 * over the authenticated control socket. Returns `undefined` for commands that
 * remain offline-only, so the caller fails closed with owner-active guidance.
 */
async function runOnlineOwnerCommand(
  parsed: ParsedCommand,
  ownership: HostRuntimeAttachment,
): Promise<DatabaseCommandResult | undefined> {
  if (!parsed.ok) return undefined;
  if (parsed.command === "backup") {
    const response = await ownership.request({
      type: "backup",
      principal: "local",
      label: "manual",
    });
    if (response?.ok === true && response.backup?.outcome === "created") {
      return {
        exitCode: 0,
        stdout: prettyJson({
          routedThroughOwner: true,
          migrationVersion: response.backup.migrationVersion,
          journalHead: response.backup.journalHead,
          byteLength: response.backup.byteLength,
        }),
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: prettyJson(
        failure("backup-failed", "The active Octant owner could not create a backup."),
      ),
    };
  }
  if (parsed.command === "restore") {
    const response = await ownership.request({ type: "restore", principal: "local" });
    if (response?.ok === true && response.restore?.outcome === "refused-online") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: prettyJson(failure("restore-requires-offline", response.restore.guidance)),
      };
    }
    return undefined;
  }
  return undefined;
}

class DatabaseOwnerActive extends Error {
  constructor() {
    super("Octant database commands require exclusive runtime ownership.");
    this.name = "DatabaseOwnerActive";
  }
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}

function buildRecoveryInput(connection: SqliteConnection, clock: () => string) {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    projections: runtime.projections,
    registry: runtime.events,
    clock,
  });
  return { connection, journal, projections: runtime.projections, clock };
}

if (import.meta.main) {
  process.exitCode = await runCli();
}
