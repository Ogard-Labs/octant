import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { sep } from "node:path";
import { decodeUtcTimestamp } from "@octant/contracts";
import type { HostUpdateFailureReason, HostUpdateStep } from "@octant/contracts/host-update";
import {
  acquireHostRuntimeOwner,
  deriveHostRuntimeHostId,
  isPathConfinedWithin,
  readHostRuntimeProcessStart,
  readHostUpdateContextFile,
  requestHostRuntimeControl,
  writeHostUpdateResultFile,
  type HeadlessArtifactRuntimeFacts,
  type HostRuntimeControlResponse,
  type HostRuntimeLocalControlRequest,
  type HostRuntimePaths,
  type HostUpdateContextFile,
  type HostUpdateResultFile,
} from "@octant/host-runtime";
import {
  HeadlessInstallError,
  installHeadlessArtifact,
  removeHeadlessUserData,
  uninstallHeadlessArtifact,
  upgradeHeadlessArtifact,
  type HeadlessArtifactSignaturePolicy,
  type HeadlessBackupReceipt,
  type HeadlessUpgradePorts,
} from "./artifactInstall";
import { OfflineStoreRestoreError, restoreOfflineStoreBackup } from "./offlineStoreRestore";
import { createUserServiceManager } from "./serviceManager";

// The `octant server install|upgrade|uninstall` command layer: flag
// parsing, report formatting, exit codes, and the production wiring of the
// upgrade coordinator's ports onto the owner control socket and the user
// service manager.

interface HeadlessArtifactCliPlacement {
  readonly artifactRoot: string;
  readonly installRoot: string;
  /** The person said they built this themselves, so no release signature is required. */
  readonly selfBuilt: boolean;
  /** Context file written by the out-of-service upgrade runner; incompatible with `--self-built`. */
  readonly updateContextPath?: string;
}

export type HeadlessArtifactCliCommand =
  | ({ readonly action: "install" } & HeadlessArtifactCliPlacement)
  | ({ readonly action: "upgrade" } & HeadlessArtifactCliPlacement)
  | {
      readonly action: "uninstall";
      readonly installRoot: string;
      readonly dataDirectory: string;
      readonly removeData: boolean;
      readonly confirmation?: string;
    };

export interface HeadlessArtifactCliDefaults {
  readonly installRoot: string;
  readonly dataDirectory: string;
}

export function resolveHeadlessArtifactCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
  defaults: HeadlessArtifactCliDefaults,
): HeadlessArtifactCliCommand | undefined {
  if (positional.length !== 1) return undefined;
  const action = positional[0];
  if (action === "install" || action === "upgrade") {
    for (const name of Object.keys(flags)) {
      const allowed =
        name === "artifact" ||
        name === "install-root" ||
        name === "self-built" ||
        (action === "upgrade" && name === "update-context");
      if (!allowed) {
        return undefined;
      }
    }
    if (typeof flags.artifact !== "string") return undefined;
    const installRoot = flags["install-root"];
    if (installRoot !== undefined && typeof installRoot !== "string") return undefined;
    const selfBuilt = flags["self-built"];
    if (selfBuilt !== undefined && selfBuilt !== true) return undefined;
    const updateContextPath = flags["update-context"];
    if (updateContextPath !== undefined && typeof updateContextPath !== "string") return undefined;
    // Remote / out-of-service host upgrades never allow `--self-built`.
    if (updateContextPath !== undefined && selfBuilt === true) return undefined;
    return {
      action,
      artifactRoot: flags.artifact,
      installRoot: installRoot ?? defaults.installRoot,
      selfBuilt: selfBuilt === true,
      ...(updateContextPath === undefined ? {} : { updateContextPath }),
    };
  }
  if (action === "uninstall") {
    for (const name of Object.keys(flags)) {
      if (
        name !== "install-root" &&
        name !== "data-dir" &&
        name !== "remove-data" &&
        name !== "confirm"
      ) {
        return undefined;
      }
    }
    const installRoot = flags["install-root"];
    if (installRoot !== undefined && typeof installRoot !== "string") return undefined;
    const dataDirectory = flags["data-dir"];
    if (dataDirectory !== undefined && typeof dataDirectory !== "string") return undefined;
    const removeData = flags["remove-data"] === true;
    if (!removeData && "confirm" in flags) return undefined;
    if (removeData && typeof flags.confirm !== "string") return undefined;
    return {
      action,
      installRoot: installRoot ?? defaults.installRoot,
      dataDirectory: dataDirectory ?? defaults.dataDirectory,
      removeData,
      ...(removeData ? { confirmation: flags.confirm as string } : {}),
    };
  }
  return undefined;
}

interface OutputWriter {
  write(chunk: string): unknown;
}

export interface RunHeadlessArtifactCliCommandOptions {
  readonly command: HeadlessArtifactCliCommand;
  readonly runtime: HeadlessArtifactRuntimeFacts;
  readonly dataDirectory: string;
  /**
   * The host's state directory. The default install root sits inside it, and
   * creating it there with the default mode would leave it open to other users,
   * which the host then refuses to start in. An install inside it makes it
   * private first.
   */
  readonly stateDirectory?: string;
  readonly ports: HeadlessUpgradePorts;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
}

/**
 * A recursive mkdir never changes the mode of a directory that already
 * exists, and an install from before this check left the state directory at
 * 0755, which the host then refuses to start in. So an existing directory is
 * tightened when it is this user's own, and refused when it is a link or
 * belongs to someone else, rather than reported as installed.
 */
async function makeStateDirectoryPrivate(stateDirectory: string): Promise<string | undefined> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const entry = await lstat(stateDirectory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    return `The state directory ${stateDirectory} is not a plain directory. Remove it or point the install elsewhere, then run the install again.`;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) {
    return `The state directory ${stateDirectory} belongs to another user. Give it to this user with mode 0700, then run the install again.`;
  }
  if ((entry.mode & 0o077) !== 0) {
    await chmod(stateDirectory, 0o700);
  }
  return undefined;
}

function signaturePolicy(selfBuilt: boolean): HeadlessArtifactSignaturePolicy {
  return selfBuilt ? { kind: "self-built" } : { kind: "release-keys" };
}

export async function runHeadlessArtifactCliCommand(
  options: RunHeadlessArtifactCliCommandOptions,
): Promise<number> {
  const { command, stdout, stderr } = options;
  try {
    if (command.action === "install") {
      const { stateDirectory } = options;
      if (
        stateDirectory !== undefined &&
        (command.installRoot === stateDirectory ||
          command.installRoot.startsWith(stateDirectory + sep))
      ) {
        const refusal = await makeStateDirectoryPrivate(stateDirectory);
        if (refusal !== undefined) {
          stderr.write(`${refusal}\n`);
          return 1;
        }
      }
      const report = await installHeadlessArtifact({
        artifactRoot: command.artifactRoot,
        installRoot: command.installRoot,
        runtime: options.runtime,
        signature: signaturePolicy(command.selfBuilt),
      });
      stdout.write(`Octant ${report.version} installed at ${command.installRoot}.\n`);
      return 0;
    }
    if (command.action === "upgrade") {
      const updateContext =
        command.updateContextPath === undefined
          ? undefined
          : await loadConfinedUpdateContext(command.updateContextPath, options.stateDirectory);
      if (command.updateContextPath !== undefined && updateContext === undefined) {
        stderr.write(
          "The update context file could not be read or is outside the state directory.\n",
        );
        return 1;
      }
      // Out-of-service host updates always verify release signatures.
      const effectiveSignature: HeadlessArtifactSignaturePolicy =
        updateContext !== undefined ? { kind: "release-keys" } : signaturePolicy(command.selfBuilt);
      try {
        const report = await upgradeHeadlessArtifact({
          artifactRoot: command.artifactRoot,
          installRoot: command.installRoot,
          runtime: options.runtime,
          signature: effectiveSignature,
          ports: options.ports,
        });
        if (updateContext !== undefined) {
          await finalizeUpdateContext(updateContext, options.stateDirectory, {
            outcome:
              report.outcome === "upgraded"
                ? "updated"
                : report.outcome === "rolled-back"
                  ? "rolled-back"
                  : "recovery-required",
            step:
              report.outcome === "upgraded"
                ? "health-check"
                : report.outcome === "rolled-back"
                  ? "roll-back"
                  : "roll-back",
            ...(report.outcome === "rolled-back"
              ? {
                  failureReason: "health-check-failed" as const,
                  storeRestored: report.storeRestored,
                }
              : report.outcome === "recovery-required"
                ? { failureReason: "restore-failed" as const, storeRestored: false }
                : {}),
          });
        }
        if (report.outcome === "upgraded") {
          stdout.write(
            `Octant upgraded from ${report.fromVersion} to ${report.toVersion}` +
              (report.storeMigration ? " with a store migration.\n" : ".\n"),
          );
          return 0;
        }
        if (report.outcome === "rolled-back") {
          stderr.write(
            `Octant ${report.toVersion} failed its health check and was rolled back to ${report.fromVersion}` +
              (report.storeRestored
                ? "; the store was restored from the verified backup.\n"
                : ".\n"),
          );
          return 1;
        }
        stderr.write(`${report.guidance}\n`);
        return 1;
      } catch (error) {
        if (updateContext !== undefined) {
          const mapped = mapUpgradeErrorToResult(error);
          await finalizeUpdateContext(updateContext, options.stateDirectory, {
            outcome: "failed",
            step: mapped.step,
            failureReason: mapped.failureReason,
          });
        }
        throw error;
      }
    }
    const report = await uninstallHeadlessArtifact({
      installRoot: command.installRoot,
      dataDirectory: command.dataDirectory,
    });
    stdout.write(`Octant uninstalled from ${command.installRoot}; user data preserved.\n`);
    if (command.removeData) {
      await removeHeadlessUserData({
        dataDirectory: command.dataDirectory,
        confirmation: command.confirmation ?? "",
      });
      stdout.write(`Octant user data removed from ${command.dataDirectory}.\n`);
    }
    return report.outcome === "uninstalled" ? 0 : 1;
  } catch (error) {
    if (error instanceof HeadlessInstallError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

// Production port wiring. Every dependency is injectable so the mapping logic
// is testable without a live owner; `createHostHeadlessUpgradePorts` binds the
// real control socket and service manager for the bin entry point.

export interface LocalControl {
  request(request: HostRuntimeLocalControlRequest): Promise<HostRuntimeControlResponse | undefined>;
}

export interface LocalServiceControl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type MaintenanceAcquisition =
  | { readonly kind: "owner"; readonly release: () => Promise<void> }
  | { readonly kind: "attached" };

async function loadConfinedUpdateContext(
  contextPath: string,
  stateDirectory: string | undefined,
): Promise<HostUpdateContextFile | undefined> {
  if (stateDirectory === undefined || !isPathConfinedWithin(stateDirectory, contextPath)) {
    return undefined;
  }
  const context = await readHostUpdateContextFile(contextPath);
  if (context === undefined || !isPathConfinedWithin(stateDirectory, context.resultPath)) {
    return undefined;
  }
  return context;
}

async function finalizeUpdateContext(
  context: HostUpdateContextFile,
  stateDirectory: string | undefined,
  terminal: {
    readonly outcome: HostUpdateResultFile["outcome"];
    readonly step: HostUpdateStep;
    readonly failureReason?: HostUpdateFailureReason;
    readonly storeRestored?: boolean;
  },
): Promise<void> {
  const result: HostUpdateResultFile = {
    schemaVersion: 1,
    requestId: context.requestId,
    actor: context.actor,
    hostKind: context.hostKind,
    fromVersion: context.fromVersion,
    toVersion: context.toVersion,
    ring: context.ring,
    drain: context.drain,
    storeMigration: context.storeMigration,
    outcome: terminal.outcome,
    step: terminal.step,
    ...(terminal.failureReason === undefined ? {} : { failureReason: terminal.failureReason }),
    ...(terminal.storeRestored === undefined ? {} : { storeRestored: terminal.storeRestored }),
    completedAt: decodeUtcTimestamp(new Date().toISOString()),
  };
  await writeHostUpdateResultFile(context.resultPath, result);
  if (stateDirectory !== undefined) {
    if (
      context.cleanupWorkDir !== undefined &&
      isPathConfinedWithin(stateDirectory, context.cleanupWorkDir)
    ) {
      await rm(context.cleanupWorkDir, { force: true, recursive: true }).catch(() => undefined);
    }
    if (
      context.cleanupLaunchdPlist !== undefined &&
      isPathConfinedWithin(stateDirectory, context.cleanupLaunchdPlist)
    ) {
      await rm(context.cleanupLaunchdPlist, { force: true }).catch(() => undefined);
    }
  }
}

function mapUpgradeErrorToResult(error: unknown): {
  readonly step: HostUpdateStep;
  readonly failureReason: HostUpdateFailureReason;
} {
  if (error instanceof HeadlessInstallError) {
    switch (error.code) {
      case "artifact-unsigned":
        return { step: "verify", failureReason: "untrusted-signature" };
      case "artifact-rejected":
        return { step: "verify", failureReason: "build-unverified" };
      case "incompatible-downgrade":
        return { step: "verify", failureReason: "downgrade-refused" };
      case "backup-required":
        return { step: "swap", failureReason: "backup-required" };
      case "owner-stop-refused":
        return { step: "swap", failureReason: "owner-stop-refused" };
      case "restore-failed":
        return { step: "roll-back", failureReason: "restore-failed" };
      default:
        return { step: "swap", failureReason: "install-failed" };
    }
  }
  return { step: "swap", failureReason: "install-failed" };
}

export interface CreateLocalHeadlessUpgradePortsOptions {
  readonly control: LocalControl;
  readonly serviceManager: LocalServiceControl;
  readonly acquireMaintenance: () => Promise<MaintenanceAcquisition>;
  /** Confined host data directory used for offline store backup restore during rollback. */
  readonly dataDirectory?: string;
  /** Test seam for offline store restore; defaults to verified SQLite restore inside `dataDirectory`. */
  readonly restoreStore?: (backupPath: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly healthAttempts?: number;
}

export function createLocalHeadlessUpgradePorts(
  options: CreateLocalHeadlessUpgradePortsOptions,
): HeadlessUpgradePorts {
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const healthAttempts = options.healthAttempts ?? 20;
  return {
    requestOwnerBackup: async (label): Promise<HeadlessBackupReceipt | undefined> => {
      const response = await options.control.request({ type: "backup", principal: "local", label });
      const backup = response?.backup;
      if (backup === undefined || backup.outcome !== "created") return undefined;
      return {
        path: backup.path,
        migrationVersion: backup.migrationVersion,
        journalHead: backup.journalHead,
        byteLength: backup.byteLength,
      };
    },
    requestOwnerStop: async () => {
      const response = await options.control.request({ type: "stop", principal: "local" });
      // No listening owner means the host is already stopped.
      if (response === undefined) return true;
      return response.ok === true;
    },
    acquireMaintenanceOwner: async () => {
      const acquisition = await options.acquireMaintenance();
      if (acquisition.kind !== "owner") {
        throw new HeadlessInstallError(
          "owner-stop-refused",
          "An Octant owner is still running; maintenance ownership is unavailable.",
        );
      }
      return { release: acquisition.release };
    },
    startService: () => options.serviceManager.start(),
    stopService: () => options.serviceManager.stop(),
    observeHealth: async () => {
      for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
        const response = await options.control.request({ type: "status", principal: "local" });
        if (response?.ok === true && response.owner !== undefined) return "ready";
        await sleep(500);
      }
      return "unready";
    },
    restoreStore: async (backupPath: string) => {
      if (options.restoreStore !== undefined) {
        await options.restoreStore(backupPath);
        return;
      }
      if (options.dataDirectory === undefined) {
        throw new HeadlessInstallError(
          "restore-failed",
          "Offline store restore requires a confined Octant data directory.",
        );
      }
      try {
        await restoreOfflineStoreBackup({
          dataDirectory: options.dataDirectory,
          backupPath,
        });
      } catch (error) {
        if (error instanceof OfflineStoreRestoreError) {
          throw new HeadlessInstallError("restore-failed", error.message);
        }
        throw new HeadlessInstallError(
          "restore-failed",
          "Octant could not restore the store from the verified backup.",
        );
      }
    },
  };
}

/** Binds the upgrade ports to the real host runtime for the bin entry point. */
export function createHostHeadlessUpgradePorts(paths: HostRuntimePaths): HeadlessUpgradePorts {
  const serviceManager = createUserServiceManager({ paths, uid: paths.uid });
  return createLocalHeadlessUpgradePorts({
    dataDirectory: paths.dataDirectory,
    control: { request: (request) => requestHostRuntimeControl(paths, request) },
    serviceManager: {
      start: async () => {
        await serviceManager.install();
        await serviceManager.start();
      },
      stop: () => serviceManager.stop(),
    },
    acquireMaintenance: async () => {
      const acquisition = await acquireHostRuntimeOwner({
        paths,
        hostId: deriveHostRuntimeHostId(paths.dataDirectory),
        instanceId: randomUUID(),
        serverVersion: "0.0.0-maintenance",
        wireVersion: "1",
        serviceMode: "maintenance",
        processStart: await readHostRuntimeProcessStart(process.pid),
      });
      if (acquisition.kind === "owner") {
        return { kind: "owner", release: () => acquisition.release() };
      }
      return { kind: "attached" };
    },
  });
}
