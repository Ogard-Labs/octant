import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  classifyCredentialCleanupOutcome,
  type CredentialCleanupBoundary,
  type CredentialPurgeAttempt,
} from "@octant/domain";
import {
  CredentialCleanupBlocked,
  DataLifecycleOperationFailed,
  PathOutsideDataDirectory,
} from "./dataLifecycleErrors";
import { isPathWithinDirectory } from "./storePath";
import type { SqliteConnection } from "./sqlitePort";

export type { CredentialPurgeAttempt } from "@octant/domain";

// Bounded destructive data-lifecycle operations with explicit retained/deleted
// scope. Every operation reports exactly what it removes and what it preserves,
// stays confined to the resolved data directory, and names the OS-keychain
// credential residual it cannot itself clear.

export type RetainedScope =
  | "host-identity"
  | "store-schema"
  | "local-event-journal"
  | "independent-hosts"
  | "external-repositories"
  | "other-stores";

export type DeletedScope =
  | "event-journal"
  | "aggregate-heads"
  | "projection-checkpoints"
  | "quarantine-observations"
  | "projections"
  | "store-files"
  | "host-identity"
  | "remote-credentials"
  | "usage-records";

export interface DataLifecycleScopeReport {
  readonly operation: "reset" | "remove-all" | "delete-remote-host";
  readonly retained: ReadonlyArray<RetainedScope>;
  readonly deleted: ReadonlyArray<DeletedScope>;
  readonly credentialCleanup?: CredentialCleanupBoundary;
}

export interface StoreResetReport extends DataLifecycleScopeReport {
  readonly operation: "reset";
  readonly clearedTableCount: number;
}

export interface RemoveAllReport extends DataLifecycleScopeReport {
  readonly operation: "remove-all";
  readonly credentialCleanup: CredentialCleanupBoundary;
  readonly removedArtifacts: ReadonlyArray<string>;
}

export interface DeleteRemoteHostReport extends DataLifecycleScopeReport {
  readonly operation: "delete-remote-host";
  readonly credentialCleanup: CredentialCleanupBoundary;
  readonly deletedRowCount: number;
}

export interface RemoveAllPreviewReport extends DataLifecycleScopeReport {
  readonly operation: "remove-all";
  readonly dryRun: true;
  readonly credentialCleanup: CredentialCleanupBoundary;
  readonly wouldRemoveArtifacts: ReadonlyArray<string>;
}

/**
 * Returns whether a prior complete-local-data operation left a verified
 * staging directory. Startup must enter recovery rather than create a fresh
 * canonical database beside that authoritative, pending removal.
 */
export function hasPendingLocalDataRemoval(input: {
  readonly dataDirectory: string;
  readonly databasePath: string;
}): boolean {
  if (!isPathWithinDirectory(input.dataDirectory, input.databasePath)) {
    throw new PathOutsideDataDirectory({ purpose: "remove" });
  }
  return (
    readExistingStagedStoreArtifacts(input.dataDirectory, basename(input.databasePath)) !==
    undefined
  );
}

/**
 * Selects the only validated SQLite source for pre-removal provider identity
 * recovery. After an interrupted removal the canonical path is deliberately
 * absent, so retrying must inspect the staged database rather than silently
 * authorizing an empty Keychain migration set.
 */
export function databasePathForPendingLocalDataRemoval(input: {
  readonly dataDirectory: string;
  readonly databasePath: string;
}): string {
  if (!isPathWithinDirectory(input.dataDirectory, input.databasePath)) {
    throw new PathOutsideDataDirectory({ purpose: "remove" });
  }
  if (existsSync(input.databasePath)) return input.databasePath;
  const recovered = readExistingStagedStoreArtifacts(
    input.dataDirectory,
    basename(input.databasePath),
  );
  if (
    recovered?.stagingDirectory !== null &&
    recovered?.artifacts.includes(basename(input.databasePath))
  ) {
    return join(recovered.stagingDirectory, basename(input.databasePath));
  }
  return input.databasePath;
}

const PRESERVED_ON_RESET = new Set(["schema_migrations", "host_identity_projection"]);

/**
 * Clears all journal, projection, checkpoint, and quarantine data while
 * preserving the store schema and the host identity. Idempotent: a second reset
 * of an already-reset store makes no further change. Foreign keys are disabled
 * only for the bulk delete and re-verified afterwards so the store is never left
 * with a dangling reference.
 */
export function resetStore(input: { readonly connection: SqliteConnection }): StoreResetReport {
  const tables = userTables(input.connection).filter((name) => !PRESERVED_ON_RESET.has(name));
  try {
    withForeignKeysDisabled(input.connection, () => {
      input.connection.transaction(() => {
        for (const table of tables) {
          input.connection.exec(`DELETE FROM ${quoteIdentifier(table)}`);
        }
      })();
    });
    if (!foreignKeysConsistent(input.connection)) {
      throw new DataLifecycleOperationFailed({ operation: "reset" });
    }
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "reset" });
  }

  return {
    operation: "reset",
    retained: ["host-identity", "store-schema", "external-repositories", "other-stores"],
    deleted: [
      "event-journal",
      "aggregate-heads",
      "projection-checkpoints",
      "quarantine-observations",
      "projections",
    ],
    clearedTableCount: tables.length,
  };
}

/**
 * Selectively deletes all in-store data belonging to one remote host without
 * touching the local host or any other host's rows. Every table that carries a
 * `host_id` is host-scoped, including the event journal itself (migration 15
 * added `event_journal.host_id`), so the remote host's journal events are
 * removed together with its derived projection and credential rows. This keeps
 * the deletion rebuild-safe: because the source events are gone, `db:rebuild`
 * cannot replay them and resurrect the host data that was just pruned. The
 * authoritative local journal (`host_id = 'local'`) is never targeted — the
 * operation refuses to run against the local host, which must use
 * {@link resetStore} or {@link removeAllLocalData} instead.
 */
export function deleteRemoteHostData(input: {
  readonly connection: SqliteConnection;
  readonly hostId: string;
  readonly platform: string;
}): DeleteRemoteHostReport {
  if (input.hostId.trim() === "" || input.hostId === LOCAL_HOST_ID) {
    throw new DataLifecycleOperationFailed({ operation: "delete-remote-host" });
  }

  const tables = userTables(input.connection);
  const hostScopedTables = tables.filter((table) =>
    tableHasColumn(input.connection, table, "host_id"),
  );
  const hasNonceStore = tables.includes("remote_request_nonce_store");
  const hasSessionStore = hostScopedTables.includes("remote_session_store");

  let deletedRowCount = 0;
  try {
    withForeignKeysDisabled(input.connection, () => {
      input.connection.transaction(() => {
        for (const table of hostScopedTables) {
          const result = input.connection
            .prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE host_id = ?`)
            .run(input.hostId);
          deletedRowCount += result.changes;
        }
        // Retire nonces whose owning session was just removed so no reference
        // survives after foreign keys are re-enabled.
        if (hasNonceStore && hasSessionStore) {
          input.connection.exec(
            "DELETE FROM remote_request_nonce_store WHERE session_id_digest NOT IN (SELECT session_id_digest FROM remote_session_store)",
          );
        }
        // Removing the host's journal events orphans its aggregate heads and can
        // leave a projection checkpoint pointing past the new journal head. Prune
        // the now-eventless aggregate heads and clamp every checkpoint to the
        // surviving head so a later verify or rebuild sees a consistent,
        // resurrection-free store.
        pruneOrphanedAggregateHeads(input.connection, tables);
        clampCheckpointsToJournalHead(input.connection, tables);
      })();
    });
    if (!foreignKeysConsistent(input.connection)) {
      throw new DataLifecycleOperationFailed({ operation: "delete-remote-host" });
    }
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "delete-remote-host" });
  }

  return {
    operation: "delete-remote-host",
    retained: ["host-identity", "store-schema", "local-event-journal", "independent-hosts"],
    deleted: ["event-journal", "remote-credentials", "usage-records"],
    credentialCleanup: classifyCredentialCleanupOutcome({
      platform: input.platform,
      attempt: { kind: "not-integrated" },
    }),
    deletedRowCount,
  };
}

const REMOVE_ALL_RETAINED: ReadonlyArray<RetainedScope> = [
  "external-repositories",
  "independent-hosts",
  "other-stores",
];
const REMOVE_ALL_DELETED: ReadonlyArray<DeletedScope> = [
  "store-files",
  "host-identity",
  "event-journal",
  "projections",
];

// The private listener's host identifier and private signing key are local
// data, too. They intentionally live outside the SQLite filename family so
// the listener can be lazily provisioned, but a confirmed complete-data
// removal must stage and remove them with the selected store. Keep this list
// exact: a `remote/` directory can hold future unrelated state and must never
// become an implicit recursive deletion target.
const PRIVATE_LISTENER_HOST_IDENTITY_ARTIFACTS = [
  join("remote", "private-listener-host-id"),
  join("remote", "private-listener-host-key.pem"),
] as const;

/**
 * Removes every Octant store file (database, WAL/SHM sidecars, and any
 * leftover backup or restore artifacts) inside the confined data directory.
 * Every live connection MUST be closed first. Nothing outside the data directory
 * is touched, so unrelated repositories, independently managed hosts, and other
 * stores are unaffected.
 *
 * When `credentialPurgeAttempt` is omitted, this reports the same
 * `not-integrated` residual as before (the caller has no reachable host
 * credential boundary). When it is supplied, the purge attempt MUST already
 * report a fully clean success (`completed`) before any filesystem mutation
 * happens; a `locked`, `unavailable`, `partial`, or `failed` attempt throws
 * {@link CredentialCleanupBlocked} and leaves the store, its sidecars, and the
 * Keychain completely untouched (fail closed, no partial "complete" removal).
 */
export function removeAllLocalData(input: {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly platform: string;
  readonly credentialPurgeAttempt?: CredentialPurgeAttempt;
}): RemoveAllReport {
  if (!isPathWithinDirectory(input.dataDirectory, input.databasePath)) {
    throw new PathOutsideDataDirectory({ purpose: "remove" });
  }

  const credentialCleanup = classifyCredentialCleanupOutcome({
    platform: input.platform,
    attempt: input.credentialPurgeAttempt ?? { kind: "not-integrated" },
  });
  const nonMacOsGap = input.platform !== "darwin" && credentialCleanup.status === "not-integrated";
  if (credentialCleanup.status !== "completed" && !nonMacOsGap) {
    throw new CredentialCleanupBlocked({
      status: credentialCleanup.status as
        | "not-integrated"
        | "locked"
        | "unavailable"
        | "partial"
        | "indeterminate"
        | "failed",
      recoveryGuidance:
        credentialCleanup.recoveryGuidance ??
        "The macOS Keychain credential broker is unavailable. No local data was changed; retry from the native desktop host.",
    });
  }

  const base = basename(input.databasePath);
  const removedArtifacts: Array<string> = [];
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(input.dataDirectory);
  } catch {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }

  const artifacts = localDataRemovalArtifacts(input.dataDirectory, base, entries);
  for (const entry of artifacts) {
    const target = `${input.dataDirectory}/${entry}`;
    if (!isPathWithinDirectory(input.dataDirectory, target)) {
      throw new PathOutsideDataDirectory({ purpose: "remove" });
    }
    try {
      rmSync(target, { force: true });
      removedArtifacts.push(entry);
    } catch {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
  }

  return {
    operation: "remove-all",
    retained: REMOVE_ALL_RETAINED,
    deleted: REMOVE_ALL_DELETED,
    credentialCleanup,
    removedArtifacts: [...removedArtifacts].sort(),
  };
}

/**
 * Renames store artifacts into a private staging directory before requesting a
 * broker-backed purge. The staged files remain recoverable until the purge has
 * fully completed. Definite locked, unavailable, partial, or failed Keychain
 * outcomes restore the canonical store; an indeterminate destructive outcome
 * remains staged until a retry reconciles it.
 */
export async function removeAllLocalDataWithCredentialPurge(input: {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly platform: string;
  /** Authoritative provider identities read from this store before staging. */
  readonly providerInstanceIds?: readonly string[];
  /** Public selected-store evidence for a pre-scope host identity, when present. */
  readonly hostIdentityFingerprint?: string;
  readonly credentialPurge: (input: {
    readonly dryRun: boolean;
    readonly providerInstanceIds: readonly string[];
    readonly hostIdentityFingerprint?: string;
  }) => Promise<CredentialPurgeAttempt>;
}): Promise<RemoveAllReport> {
  if (!isPathWithinDirectory(input.dataDirectory, input.databasePath)) {
    throw new PathOutsideDataDirectory({ purpose: "remove" });
  }

  if (input.platform === "darwin") {
    const preflight = await input.credentialPurge({
      dryRun: true,
      providerInstanceIds: input.providerInstanceIds ?? [],
      ...(input.hostIdentityFingerprint === undefined
        ? {}
        : { hostIdentityFingerprint: input.hostIdentityFingerprint }),
    });
    if (preflight.kind !== "dry-run") {
      const cleanup = classifyCredentialCleanupOutcome({
        platform: input.platform,
        attempt: preflight,
      });
      throw new CredentialCleanupBlocked({
        status: cleanup.status as
          | "not-integrated"
          | "locked"
          | "unavailable"
          | "partial"
          | "indeterminate"
          | "failed",
        recoveryGuidance:
          cleanup.recoveryGuidance ??
          "The macOS Keychain credential broker is unavailable. No local data was changed; retry from the native desktop host.",
      });
    }
  }

  const staged = stageStoreArtifacts(input.dataDirectory, input.databasePath);
  let credentialPurgeAttempt: CredentialPurgeAttempt;
  let purgeOutcomeWasIndeterminate = false;
  try {
    credentialPurgeAttempt =
      input.platform === "darwin"
        ? await input.credentialPurge({
            dryRun: false,
            providerInstanceIds: input.providerInstanceIds ?? [],
            ...(input.hostIdentityFingerprint === undefined
              ? {}
              : { hostIdentityFingerprint: input.hostIdentityFingerprint }),
          })
        : ({ kind: "not-integrated" } satisfies CredentialPurgeAttempt);
  } catch {
    // The destructive request may have reached the broker before transport
    // failed. Keep the store staged and reconcile the idempotent purge below.
    credentialPurgeAttempt = { kind: "indeterminate" };
  }

  if (credentialPurgeAttempt.kind === "indeterminate") {
    purgeOutcomeWasIndeterminate = true;
    try {
      // Deleting an absent Keychain item is a successful no-op, so one retry
      // is a safe reconciliation boundary for a lost post-dispatch response.
      credentialPurgeAttempt = await input.credentialPurge({
        dryRun: false,
        providerInstanceIds: input.providerInstanceIds ?? [],
        ...(input.hostIdentityFingerprint === undefined
          ? {}
          : { hostIdentityFingerprint: input.hostIdentityFingerprint }),
      });
    } catch {
      credentialPurgeAttempt = { kind: "indeterminate" };
    }
  }
  const credentialCleanup = classifyCredentialCleanupOutcome({
    platform: input.platform,
    attempt: credentialPurgeAttempt,
  });
  const nonMacOsGap = input.platform !== "darwin" && credentialCleanup.status === "not-integrated";
  if (credentialCleanup.status !== "completed" && !nonMacOsGap) {
    const stagedOutcomeIsUncertain = purgeOutcomeWasIndeterminate || staged.hasRecoveredArtifacts;
    if (!stagedOutcomeIsUncertain) {
      restoreStagedStoreArtifacts(staged, input.dataDirectory);
    }
    throw new CredentialCleanupBlocked({
      status: stagedOutcomeIsUncertain
        ? "indeterminate"
        : (credentialCleanup.status as
            | "not-integrated"
            | "locked"
            | "unavailable"
            | "partial"
            | "failed"),
      recoveryGuidance: stagedOutcomeIsUncertain
        ? "The Keychain cleanup outcome could not be confirmed. Local store files remain staged; retry complete local-data removal to reconcile before using this store."
        : (credentialCleanup.recoveryGuidance ?? "Retry complete local-data removal."),
    });
  }

  discardStagedStoreArtifacts(staged);

  return {
    operation: "remove-all",
    retained: REMOVE_ALL_RETAINED,
    deleted: REMOVE_ALL_DELETED,
    credentialCleanup,
    removedArtifacts: staged.artifacts,
  };
}

function stageStoreArtifacts(dataDirectory: string, databasePath: string): StagedStoreArtifacts {
  const base = basename(databasePath);
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(dataDirectory);
  } catch {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }

  const artifacts = localDataRemovalArtifacts(dataDirectory, base, entries);
  const recovered = readExistingStagedStoreArtifacts(dataDirectory, base);
  if (
    recovered !== undefined &&
    artifacts.some((artifact) => recovered.artifacts.includes(artifact))
  ) {
    // A canonical and already-staged copy of the same artifact leaves its
    // provenance ambiguous. Refuse rather than guessing which copy to purge.
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
  if (artifacts.length === 0 && recovered === undefined)
    return { artifacts, stagingDirectory: null, hasRecoveredArtifacts: false };

  let stagingDirectory = recovered?.stagingDirectory;
  try {
    stagingDirectory ??= mkdtempSync(join(dataDirectory, ".octant-remove-"));
  } catch {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
  const moved: Array<string> = [];
  try {
    for (const entry of artifacts) {
      const source = join(dataDirectory, entry);
      const staged = join(stagingDirectory, entry);
      if (
        !isPathWithinDirectory(dataDirectory, source) ||
        !isPathWithinDirectory(stagingDirectory, staged)
      ) {
        throw new PathOutsideDataDirectory({ purpose: "remove" });
      }
      // `remote/private-listener-*` artifacts retain their relative path in
      // staging. Create only that known parent; never move the entire remote
      // directory, which could contain data outside this removal contract.
      mkdirSync(dirname(staged), { recursive: true });
      renameSync(source, staged);
      moved.push(entry);
    }
    return {
      artifacts: [...(recovered?.artifacts ?? []), ...moved].sort(),
      stagingDirectory,
      hasRecoveredArtifacts: recovered !== undefined,
    };
  } catch {
    restoreStagedStoreArtifacts(
      { artifacts: moved, stagingDirectory, hasRecoveredArtifacts: false },
      dataDirectory,
      recovered === undefined,
    );
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
}

interface StagedStoreArtifacts {
  readonly artifacts: ReadonlyArray<string>;
  readonly stagingDirectory: string | null;
  /** A prior process left these artifacts after an unconfirmed purge request. */
  readonly hasRecoveredArtifacts: boolean;
}

/**
 * A prior process may have been interrupted after renaming store files but
 * before it could reconcile the Keychain result. The next removal treats that
 * verified staging directory as part of the same pending operation instead of
 * silently overlooking recoverable store data.
 */
function readExistingStagedStoreArtifacts(
  dataDirectory: string,
  databaseBaseName: string,
): StagedStoreArtifacts | undefined {
  let candidates: ReadonlyArray<string>;
  try {
    candidates = readdirSync(dataDirectory)
      .filter((entry) => entry.startsWith(".octant-remove-"))
      .sort();
  } catch {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
  if (candidates.length === 0) return undefined;
  // Runtime ownership prevents concurrent removals. More than one staging
  // directory therefore has ambiguous provenance and must be handled manually.
  if (candidates.length !== 1) throw new DataLifecycleOperationFailed({ operation: "remove-all" });

  const candidate = candidates[0]!;
  const stagingDirectory = join(dataDirectory, candidate);
  try {
    if (
      !isPathWithinDirectory(dataDirectory, stagingDirectory) ||
      !lstatSync(stagingDirectory).isDirectory()
    ) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
    const rootEntries = readdirSync(stagingDirectory).sort();
    const artifacts: string[] = [];
    for (const entry of rootEntries) {
      if (isStoreArtifact(entry, databaseBaseName)) {
        artifacts.push(entry);
        continue;
      }
      if (entry !== "remote") {
        throw new DataLifecycleOperationFailed({ operation: "remove-all" });
      }
      const stagedRemoteDirectory = join(stagingDirectory, entry);
      if (!lstatSync(stagedRemoteDirectory).isDirectory()) {
        throw new DataLifecycleOperationFailed({ operation: "remove-all" });
      }
      for (const remoteEntry of readdirSync(stagedRemoteDirectory).sort()) {
        const artifact = join("remote", remoteEntry);
        if (!PRIVATE_LISTENER_HOST_IDENTITY_ARTIFACTS.includes(artifact as never)) {
          throw new DataLifecycleOperationFailed({ operation: "remove-all" });
        }
        artifacts.push(artifact);
      }
    }
    validateStoreArtifacts(stagingDirectory, artifacts, databaseBaseName);
    return { artifacts, stagingDirectory, hasRecoveredArtifacts: true };
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
}

function validateStoreArtifacts(
  dataDirectory: string,
  artifacts: ReadonlyArray<string>,
  databaseBaseName: string,
): void {
  try {
    for (const entry of artifacts) {
      const target = join(dataDirectory, entry);
      if (
        !isLocalDataRemovalArtifact(entry, databaseBaseName) ||
        !isPathWithinDirectory(dataDirectory, target) ||
        !lstatSync(target).isFile()
      ) {
        throw new DataLifecycleOperationFailed({ operation: "remove-all" });
      }
    }
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
}

function restoreStagedStoreArtifacts(
  staged: StagedStoreArtifacts,
  dataDirectory: string,
  removeStagingDirectory = true,
): void {
  if (staged.stagingDirectory === null) return;
  try {
    for (const entry of staged.artifacts) {
      const source = join(staged.stagingDirectory, entry);
      const destination = join(dataDirectory, entry);
      if (
        !isPathWithinDirectory(staged.stagingDirectory, source) ||
        !isPathWithinDirectory(dataDirectory, destination) ||
        existsSync(destination)
      ) {
        throw new DataLifecycleOperationFailed({ operation: "remove-all" });
      }
      renameSync(source, destination);
    }
    removeEmptyStagedArtifactDirectories(staged);
    if (removeStagingDirectory) rmdirSync(staged.stagingDirectory);
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
}

function discardStagedStoreArtifacts(staged: StagedStoreArtifacts): void {
  if (staged.stagingDirectory === null) return;
  try {
    for (const entry of staged.artifacts) {
      const target = join(staged.stagingDirectory, entry);
      if (!isPathWithinDirectory(staged.stagingDirectory, target) || !lstatSync(target).isFile()) {
        throw new DataLifecycleOperationFailed({ operation: "remove-all" });
      }
      rmSync(target);
    }
    removeEmptyStagedArtifactDirectories(staged);
    rmdirSync(staged.stagingDirectory);
  } catch (error) {
    if (error instanceof DataLifecycleOperationFailed) throw error;
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
}

/**
 * Non-destructive preview of {@link removeAllLocalData}: reports exactly which
 * store artifacts would be removed and, when a `credentialPurgeAttempt` from a
 * real dry-run Keychain enumeration is supplied, exactly how many Octant
 * Keychain items would be deleted. Never deletes a file or a credential, and
 * never throws for a locked/unavailable/partial Keychain state — the caller
 * can inspect `credentialCleanup` to see whether a real removal would
 * currently succeed.
 */
export function previewLocalDataRemoval(input: {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly platform: string;
  readonly credentialPurgeAttempt?: CredentialPurgeAttempt;
}): RemoveAllPreviewReport {
  if (!isPathWithinDirectory(input.dataDirectory, input.databasePath)) {
    throw new PathOutsideDataDirectory({ purpose: "remove" });
  }

  const base = basename(input.databasePath);
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(input.dataDirectory);
  } catch {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
  const rootArtifacts = localDataRemovalArtifacts(input.dataDirectory, base, entries);
  // The preview is an exact non-mutating inventory of the confirmed path, not
  // a looser list that advertises directories or symlinks the real operation
  // must refuse for safety.
  const recovered = readExistingStagedStoreArtifacts(input.dataDirectory, base);
  if (
    recovered !== undefined &&
    rootArtifacts.some((artifact) => recovered.artifacts.includes(artifact))
  ) {
    throw new DataLifecycleOperationFailed({ operation: "remove-all" });
  }
  const wouldRemoveArtifacts = [...rootArtifacts, ...(recovered?.artifacts ?? [])].sort();

  return {
    operation: "remove-all",
    dryRun: true,
    retained: REMOVE_ALL_RETAINED,
    deleted: REMOVE_ALL_DELETED,
    credentialCleanup: classifyCredentialCleanupOutcome({
      platform: input.platform,
      attempt: input.credentialPurgeAttempt ?? { kind: "not-integrated" },
    }),
    wouldRemoveArtifacts,
  };
}

function isStoreArtifact(entry: string, databaseBaseName: string): boolean {
  return (
    basename(entry) === entry &&
    (entry === databaseBaseName ||
      entry.startsWith(`${databaseBaseName}-`) ||
      entry.startsWith(`${databaseBaseName}.`))
  );
}

function isLocalDataRemovalArtifact(entry: string, databaseBaseName: string): boolean {
  return (
    isStoreArtifact(entry, databaseBaseName) ||
    PRIVATE_LISTENER_HOST_IDENTITY_ARTIFACTS.includes(entry as never)
  );
}

function localDataRemovalArtifacts(
  dataDirectory: string,
  databaseBaseName: string,
  entries: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const artifacts = entries.filter((entry) => isStoreArtifact(entry, databaseBaseName));
  const remoteDirectory = join(dataDirectory, "remote");
  try {
    if (lstatSync(remoteDirectory).isDirectory()) {
      for (const entry of readdirSync(remoteDirectory)) {
        const artifact = join("remote", entry);
        if (PRIVATE_LISTENER_HOST_IDENTITY_ARTIFACTS.includes(artifact as never)) {
          artifacts.push(artifact);
        }
      }
    }
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw new DataLifecycleOperationFailed({ operation: "remove-all" });
    }
  }
  const sorted = artifacts.sort();
  validateStoreArtifacts(dataDirectory, sorted, databaseBaseName);
  return sorted;
}

function removeEmptyStagedArtifactDirectories(staged: StagedStoreArtifacts): void {
  if (staged.stagingDirectory === null) return;
  const directories = [...new Set(staged.artifacts.map((artifact) => dirname(artifact)))].filter(
    (directory) => directory !== ".",
  );
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const target = join(staged.stagingDirectory, directory);
    if (!isPathWithinDirectory(staged.stagingDirectory, target)) {
      throw new PathOutsideDataDirectory({ purpose: "remove" });
    }
    rmdirSync(target);
  }
}

function userTables(connection: SqliteConnection): ReadonlyArray<string> {
  return (
    connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as ReadonlyArray<{ readonly name: string }>
  ).map((row) => row.name);
}

function pruneOrphanedAggregateHeads(
  connection: SqliteConnection,
  tables: ReadonlyArray<string>,
): void {
  if (!tables.includes("aggregate_heads")) return;
  connection.exec(
    "DELETE FROM aggregate_heads WHERE NOT EXISTS (SELECT 1 FROM event_journal WHERE event_journal.aggregate_type = aggregate_heads.aggregate_type AND event_journal.aggregate_id = aggregate_heads.aggregate_id)",
  );
}

function clampCheckpointsToJournalHead(
  connection: SqliteConnection,
  tables: ReadonlyArray<string>,
): void {
  if (!tables.includes("projection_checkpoints")) return;
  // A projection that was caught up before the deletion has, by definition,
  // already applied every surviving (lower-sequence) event, so pinning its
  // checkpoint to the new head keeps it current instead of ahead of the journal.
  connection.exec(
    "UPDATE projection_checkpoints SET last_sequence = (SELECT coalesce(max(global_sequence), 0) FROM event_journal) WHERE last_sequence > (SELECT coalesce(max(global_sequence), 0) FROM event_journal)",
  );
}

function tableHasColumn(connection: SqliteConnection, table: string, column: string): boolean {
  const columns = connection
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as ReadonlyArray<{ readonly name: string }>;
  return columns.some((entry) => entry.name === column);
}

function withForeignKeysDisabled(connection: SqliteConnection, body: () => void): void {
  connection.pragma("foreign_keys = OFF");
  try {
    body();
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

function foreignKeysConsistent(connection: SqliteConnection): boolean {
  const violations = connection.pragma("foreign_key_check") as ReadonlyArray<unknown>;
  return violations.length === 0;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
