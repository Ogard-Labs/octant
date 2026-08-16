import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  decodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  inspectHeadlessArtifact,
  type HeadlessArtifactManifest,
  type HeadlessArtifactRuntimeFacts,
} from "@octant/host-runtime";

// Coordinates headless install, upgrade, rollback, uninstall, and data
// removal. Every destructive step is preceded by a verified precondition:
// artifacts are inspected before staging and re-verified after copy, store
// migrations require a verified backup receipt, and removals stay confined to
// the exact directories they were asked to touch.

export type HeadlessInstallErrorCode =
  | "artifact-rejected"
  | "version-already-installed"
  | "not-installed"
  | "incompatible-downgrade"
  | "backup-required"
  | "owner-stop-refused"
  | "data-confinement"
  | "confirmation-mismatch";

export class HeadlessInstallError extends Error {
  override readonly name = "HeadlessInstallError";
  readonly code: HeadlessInstallErrorCode;

  constructor(code: HeadlessInstallErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HeadlessBackupReceipt {
  readonly path: string;
  readonly migrationVersion: number;
  readonly journalHead: number;
  readonly byteLength: number;
}

export interface HeadlessMaintenanceOwner {
  readonly release: () => Promise<void>;
}

/**
 * Injected side-effect ports for the upgrade coordinator. Production wires
 * these to the owner control socket and the user service manager; tests use
 * fixtures.
 */
export interface HeadlessUpgradePorts {
  /** Verified online backup through the owner. `undefined` means unavailable. */
  readonly requestOwnerBackup: (label: string) => Promise<HeadlessBackupReceipt | undefined>;
  /** Graceful stop through the owner. `false` means the owner refused. */
  readonly requestOwnerStop: () => Promise<boolean>;
  /** Exclusive maintenance ownership held across the atomic switch. */
  readonly acquireMaintenanceOwner: () => Promise<HeadlessMaintenanceOwner>;
  readonly startService: () => Promise<void>;
  readonly stopService: () => Promise<void>;
  readonly observeHealth: () => Promise<"ready" | "unready">;
  /** Offline restore of the store from a verified backup path. */
  readonly restoreStore: (backupPath: string) => Promise<void>;
}

export interface StageHeadlessArtifactOptions {
  readonly artifactRoot: string;
  readonly installRoot: string;
  readonly runtime: HeadlessArtifactRuntimeFacts;
}

export interface StagedHeadlessArtifact {
  readonly manifest: HeadlessArtifactManifest;
  readonly versionRoot: string;
}

export interface HeadlessInstallReport {
  readonly outcome: "installed";
  readonly version: string;
}

export interface UpgradeHeadlessArtifactOptions extends StageHeadlessArtifactOptions {
  readonly ports: HeadlessUpgradePorts;
}

export type HeadlessUpgradeReport =
  | {
      readonly outcome: "upgraded";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly storeMigration: boolean;
    }
  | {
      readonly outcome: "rolled-back";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly storeRestored: boolean;
    }
  | {
      readonly outcome: "recovery-required";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly backupPath: string;
      readonly guidance: string;
    };

export interface UninstallHeadlessArtifactOptions {
  readonly installRoot: string;
  readonly dataDirectory: string;
}

export interface HeadlessUninstallReport {
  readonly outcome: "uninstalled";
  readonly dataPreserved: true;
}

export interface RemoveHeadlessUserDataOptions {
  readonly dataDirectory: string;
  /** Must equal the canonical data directory path exactly. */
  readonly confirmation: string;
}

export interface HeadlessUserDataRemovalReport {
  readonly outcome: "removed";
  readonly dataDirectory: string;
}

const CURRENT_LINK = "current";
const VERSIONS_DIRECTORY = "versions";
const STAGING_DIRECTORY = "staging";

/**
 * Inspects the artifact, copies it into a private staging directory, verifies
 * the staged bytes again, and atomically promotes the copy to an immutable
 * version directory. A rejected artifact never appears under `versions/`.
 */
export async function stageHeadlessArtifact(
  options: StageHeadlessArtifactOptions,
): Promise<StagedHeadlessArtifact> {
  const manifest = await inspectOrReject(options.artifactRoot, options.runtime);
  const versionRoot = join(options.installRoot, VERSIONS_DIRECTORY, manifest.artifactVersion);
  if (await pathExists(versionRoot)) {
    throw new HeadlessInstallError(
      "version-already-installed",
      `Octant version ${manifest.artifactVersion} is already installed; refusing to overwrite it.`,
    );
  }
  const stagingRoot = join(
    options.installRoot,
    STAGING_DIRECTORY,
    `${manifest.artifactVersion}-${randomBytes(6).toString("hex")}`,
  );
  await mkdir(stagingRoot, { recursive: true });
  try {
    for (const component of manifest.components) {
      const destination = join(stagingRoot, component.path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(options.artifactRoot, component.path), destination, {
        dereference: false,
      });
    }
    await cp(
      join(options.artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
      join(stagingRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME),
      { dereference: false },
    );
    // Re-verify the staged copy so a mid-copy mutation of the source cannot
    // promote unverified bytes.
    await inspectOrReject(stagingRoot, options.runtime);
    await mkdir(dirname(versionRoot), { recursive: true });
    await rename(stagingRoot, versionRoot);
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
    await rm(join(options.installRoot, STAGING_DIRECTORY), { force: true, recursive: true });
  }
  return { manifest, versionRoot };
}

/** Stages the artifact and atomically points the `current` link at it. */
export async function installHeadlessArtifact(
  options: StageHeadlessArtifactOptions,
): Promise<HeadlessInstallReport> {
  const staged = await stageHeadlessArtifact(options);
  await switchCurrentLink(options.installRoot, staged.versionRoot);
  return { outcome: "installed", version: staged.manifest.artifactVersion };
}

/**
 * Full upgrade flow: stage and verify the candidate before touching the
 * running host, refuse store downgrades, require a verified backup before a
 * migrating upgrade, gracefully stop the owner, atomically switch under
 * maintenance ownership, restart, observe health, and roll back on failure.
 */
export async function upgradeHeadlessArtifact(
  options: UpgradeHeadlessArtifactOptions,
): Promise<HeadlessUpgradeReport> {
  const { ports } = options;
  const current = await readCurrentInstallation(options.installRoot);
  const staged = await stageHeadlessArtifact(options);
  const fromVersion = current.manifest.artifactVersion;
  const toVersion = staged.manifest.artifactVersion;

  if (staged.manifest.storeVersion < current.manifest.storeVersion) {
    throw new HeadlessInstallError(
      "incompatible-downgrade",
      `Octant ${toVersion} targets store version ${staged.manifest.storeVersion}, older than the installed store version ${current.manifest.storeVersion}; downgrade would corrupt the store.`,
    );
  }
  const storeMigration = staged.manifest.storeVersion > current.manifest.storeVersion;

  let backup: HeadlessBackupReceipt | undefined;
  if (storeMigration) {
    backup = await ports.requestOwnerBackup("pre-upgrade");
    if (backup === undefined) {
      throw new HeadlessInstallError(
        "backup-required",
        "Octant refuses to migrate the store without a verified backup; create one and retry.",
      );
    }
  }

  const stopped = await ports.requestOwnerStop();
  if (!stopped) {
    throw new HeadlessInstallError(
      "owner-stop-refused",
      "The running Octant owner refused a graceful stop; the upgrade was not applied.",
    );
  }

  await withMaintenanceOwner(ports, () =>
    switchCurrentLink(options.installRoot, staged.versionRoot),
  );
  await ports.startService();
  const health = await ports.observeHealth();
  if (health === "ready") {
    return { outcome: "upgraded", fromVersion, toVersion, storeMigration };
  }

  // Failed health: stop the unhealthy candidate before touching the store.
  await ports.stopService();
  if (backup !== undefined) {
    try {
      await ports.restoreStore(backup.path);
    } catch {
      // The store may be partially migrated and the restore failed, so the
      // older binary must never be restarted against it.
      return {
        outcome: "recovery-required",
        fromVersion,
        toVersion,
        backupPath: backup.path,
        guidance: `Octant is stopped. Restore the store manually from ${backup.path} with the offline database CLI, then restart.`,
      };
    }
  }
  await withMaintenanceOwner(ports, () =>
    switchCurrentLink(options.installRoot, current.versionRoot),
  );
  await ports.startService();
  return { outcome: "rolled-back", fromVersion, toVersion, storeRestored: backup !== undefined };
}

/**
 * Removes the install root (versions and the current link) while preserving
 * the user data directory. Refuses layouts where removal could touch data.
 */
export async function uninstallHeadlessArtifact(
  options: UninstallHeadlessArtifactOptions,
): Promise<HeadlessUninstallReport> {
  const installRoot = resolve(options.installRoot);
  const dataDirectory = resolve(options.dataDirectory);
  if (dataDirectory === installRoot || dataDirectory.startsWith(installRoot + sep)) {
    throw new HeadlessInstallError(
      "data-confinement",
      "The data directory lies inside the install root; uninstall would destroy user data.",
    );
  }
  await rm(installRoot, { force: true, recursive: true });
  return { outcome: "uninstalled", dataPreserved: true };
}

/**
 * Destroys the canonical data directory. Requires the confirmation string to
 * equal the exact directory path, and refuses symlinked directories so the
 * removal cannot escape the canonical location.
 */
export async function removeHeadlessUserData(
  options: RemoveHeadlessUserDataOptions,
): Promise<HeadlessUserDataRemovalReport> {
  const dataDirectory = options.dataDirectory;
  if (options.confirmation !== dataDirectory) {
    throw new HeadlessInstallError(
      "confirmation-mismatch",
      "User-data removal requires confirming the exact canonical data directory path.",
    );
  }
  if (!isAbsolute(dataDirectory) || resolve(dataDirectory) !== dataDirectory) {
    throw new HeadlessInstallError(
      "data-confinement",
      "User-data removal requires the canonical absolute data directory path.",
    );
  }
  const metadata = await lstat(dataDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new HeadlessInstallError(
      "data-confinement",
      "The data directory is a symlink or not a directory; removal could escape the canonical location.",
    );
  }
  await rm(dataDirectory, { force: true, recursive: true });
  return { outcome: "removed", dataDirectory };
}

async function inspectOrReject(
  artifactRoot: string,
  runtime: HeadlessArtifactRuntimeFacts,
): Promise<HeadlessArtifactManifest> {
  const inspection = await inspectHeadlessArtifact({ artifactRoot, runtime });
  if (!inspection.ok) {
    throw new HeadlessInstallError(
      "artifact-rejected",
      `Octant artifact inspection rejected this artifact: ${inspection.rejection.code}.`,
    );
  }
  return inspection.manifest;
}

async function readCurrentInstallation(
  installRoot: string,
): Promise<{ readonly manifest: HeadlessArtifactManifest; readonly versionRoot: string }> {
  let versionRoot: string;
  try {
    versionRoot = await readlink(join(installRoot, CURRENT_LINK));
  } catch {
    throw new HeadlessInstallError(
      "not-installed",
      "No Octant version is currently installed at this install root.",
    );
  }
  const manifest = decodeHeadlessArtifactManifest(
    await readFile(join(versionRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "utf8"),
  );
  return { manifest, versionRoot };
}

async function withMaintenanceOwner(
  ports: HeadlessUpgradePorts,
  action: () => Promise<void>,
): Promise<void> {
  const maintenance = await ports.acquireMaintenanceOwner();
  try {
    await action();
  } finally {
    await maintenance.release();
  }
}

async function switchCurrentLink(installRoot: string, versionRoot: string): Promise<void> {
  await mkdir(installRoot, { recursive: true });
  const temporary = join(installRoot, `.${CURRENT_LINK}-${randomBytes(6).toString("hex")}`);
  await symlink(versionRoot, temporary);
  try {
    await rename(temporary, join(installRoot, CURRENT_LINK));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
