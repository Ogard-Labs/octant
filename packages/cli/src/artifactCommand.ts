import { randomUUID } from "node:crypto";
import {
  acquireHostRuntimeOwner,
  deriveHostRuntimeHostId,
  readHostRuntimeProcessStart,
  requestHostRuntimeControl,
  type HeadlessArtifactRuntimeFacts,
  type HostRuntimeControlResponse,
  type HostRuntimeLocalControlRequest,
  type HostRuntimePaths,
} from "@octant/host-runtime";
import {
  HeadlessInstallError,
  installHeadlessArtifact,
  removeHeadlessUserData,
  uninstallHeadlessArtifact,
  upgradeHeadlessArtifact,
  type HeadlessBackupReceipt,
  type HeadlessUpgradePorts,
} from "./artifactInstall";
import { createUserServiceManager } from "./serviceManager";

// The `octant server install|upgrade|uninstall` command layer: flag
// parsing, report formatting, exit codes, and the production wiring of the
// upgrade coordinator's ports onto the owner control socket and the user
// service manager.

export type HeadlessArtifactCliCommand =
  | { readonly action: "install"; readonly artifactRoot: string; readonly installRoot: string }
  | { readonly action: "upgrade"; readonly artifactRoot: string; readonly installRoot: string }
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
      if (name !== "artifact" && name !== "install-root") return undefined;
    }
    if (typeof flags.artifact !== "string") return undefined;
    const installRoot = flags["install-root"];
    if (installRoot !== undefined && typeof installRoot !== "string") return undefined;
    return {
      action,
      artifactRoot: flags.artifact,
      installRoot: installRoot ?? defaults.installRoot,
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
  readonly ports: HeadlessUpgradePorts;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
}

export async function runHeadlessArtifactCliCommand(
  options: RunHeadlessArtifactCliCommandOptions,
): Promise<number> {
  const { command, stdout, stderr } = options;
  try {
    if (command.action === "install") {
      const report = await installHeadlessArtifact({
        artifactRoot: command.artifactRoot,
        installRoot: command.installRoot,
        runtime: options.runtime,
      });
      stdout.write(`Octant ${report.version} installed at ${command.installRoot}.\n`);
      return 0;
    }
    if (command.action === "upgrade") {
      const report = await upgradeHeadlessArtifact({
        artifactRoot: command.artifactRoot,
        installRoot: command.installRoot,
        runtime: options.runtime,
        ports: options.ports,
      });
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
            (report.storeRestored ? "; the store was restored from the verified backup.\n" : ".\n"),
        );
        return 1;
      }
      stderr.write(`${report.guidance}\n`);
      return 1;
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

export interface CreateLocalHeadlessUpgradePortsOptions {
  readonly control: LocalControl;
  readonly serviceManager: LocalServiceControl;
  readonly acquireMaintenance: () => Promise<MaintenanceAcquisition>;
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
    restoreStore: async () => {
      // The CLI package has no offline restore engine; fail closed so the
      // coordinator reports recovery-required with operator guidance instead
      // of guessing at a destructive restore.
      throw new HeadlessInstallError(
        "backup-required",
        "Offline store restore must run through the server database CLI while Octant is stopped.",
      );
    },
  };
}

/** Binds the upgrade ports to the real host runtime for the bin entry point. */
export function createHostHeadlessUpgradePorts(paths: HostRuntimePaths): HeadlessUpgradePorts {
  const serviceManager = createUserServiceManager({ paths, uid: paths.uid });
  return createLocalHeadlessUpgradePorts({
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
