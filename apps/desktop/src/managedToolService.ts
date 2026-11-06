import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ManagedToolStatus, ManagedToolsStatus } from "@octant/contracts/managed-tooling";
import {
  BUNDLED_MANAGED_TOOL_RELEASES,
  MANAGED_TOOLS,
  boundedRegistryDownload,
  commitManagedTool,
  isInsideManagedToolLocation,
  latestManagedToolRelease,
  readInstalledManagedTool,
  resolveManagedToolRelease,
  stageManagedTool,
  type ManagedFetch,
  type ManagedToolDescriptor,
  type StagedManagedTool,
} from "./managedToolRelease";
import { createManagedToolUpdates, type ManagedToolUpdateState } from "./managedToolUpdates";
import { confineManagedDeviceTool } from "./managedDeviceToolConfinement";

interface ManagedToolInstance {
  readonly descriptor: ManagedToolDescriptor;
  readonly bundled: StagedManagedTool;
  readonly root: string;
  readonly updates: ReturnType<typeof createManagedToolUpdates>;
  readonly state: { active: StagedManagedTool; running: number };
}

/**
 * The variables a managed tool may read from the desktop's environment. These
 * tools come from npm with integrity but no publisher signature, so they get
 * only what `xcrun simctl`, `adb`, and Node need to start,
 * never the provider keys, tokens, or broker secrets the desktop process holds.
 */
const TOOL_ENVIRONMENT_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DEVELOPER_DIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_USER_HOME",
  "ANDROID_AVD_HOME",
  "ANDROID_EMULATOR_HOME",
  "ANDROID_ADB_SERVER_PORT",
];

function allowlistedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of TOOL_ENVIRONMENT_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Tool executions run under the desktop's own runtime, never a system node. */
function toolEnvironment(): NodeJS.ProcessEnv {
  return { ...allowlistedEnvironment(), ELECTRON_RUN_AS_NODE: "1" };
}

export function createManagedToolService(options: {
  /** Directory holding the vendored per-tool package trees shipped in the app. */
  readonly bundledToolsDirectory: string;
  readonly dataDirectory: string;
  /** The runtime the tools launch under (`process.execPath` — Electron-as-node). */
  readonly execPath: string;
  readonly isBusy?: () => boolean;
  /** Registry fetch; injectable so tests can exercise updates without network. */
  readonly fetchBytes?: ManagedFetch;
  /** How long a staged tool must survive its smoke launch; injectable for tests. */
  readonly smokeTimeoutMs?: number;
  /** Native boundary injectable for process fixtures; production uses the scoped device profile. */
  readonly confineDeviceTool?: typeof confineManagedDeviceTool;
}) {
  const rootDirectory = join(options.dataDirectory, "managed-tools");
  const settingsPath = join(rootDirectory, "settings.json");
  const supported = process.platform === "darwin" || process.platform === "linux";
  // npm proves integrity, not publisher, so a new release waits for a person
  // unless they turned automatic updates on.
  let settingsAutomaticUpdates = false;
  let initializing: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const trackedProcesses = new Set<ChildProcess>();
  let deviceState: Promise<string> | undefined;
  const deviceStateDirectory = () =>
    (deviceState ??= mkdtemp(join(tmpdir(), "octant-device-tools-")));
  const prepareDeviceTool = options.confineDeviceTool ?? confineManagedDeviceTool;
  const launchFailures = new Map<string, string>();

  async function deviceLaunch(
    tool: string,
    entrypoint: string,
    args: ReadonlyArray<string>,
    sdkRoot?: string,
  ) {
    if (tool !== "serve-sim" && tool !== "serve-avd") return undefined;
    const spec = prepareDeviceTool({
      tool,
      runtime: options.execPath,
      entrypoint,
      args,
      environment: {
        ...toolEnvironment(),
        ...(tool === "serve-avd" ? { ADB_MDNS: "0" } : {}),
        ...(sdkRoot === undefined ? {} : { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot }),
      },
      stateDirectory: await deviceStateDirectory(),
    });
    if (spec === undefined)
      launchFailures.set(
        tool,
        "Cannot start the managed stream safely on this host. Check the SDK and device-tool setup.",
      );
    else launchFailures.delete(tool);
    return spec;
  }

  const bundledReleaseFor = (packageName: string) =>
    BUNDLED_MANAGED_TOOL_RELEASES.find((release) => release.packageName === packageName);

  const bundledDescriptorFor = (descriptor: ManagedToolDescriptor): StagedManagedTool => {
    const bundled = bundledReleaseFor(descriptor.packageName);
    const path = join(options.bundledToolsDirectory, descriptor.tool);
    return {
      version: bundled?.version ?? "0.0.0",
      path,
      entrypoint: join(path, descriptor.entrypoint),
    };
  };

  async function readSettings(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        "automaticUpdates" in value &&
        typeof (value as { automaticUpdates: unknown }).automaticUpdates === "boolean"
      )
        return (value as { automaticUpdates: boolean }).automaticUpdates;
      return false;
    } catch {
      return false;
    }
  }

  async function writeSettings(): Promise<void> {
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(rootDirectory, `.settings-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify({ automaticUpdates: settingsAutomaticUpdates }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, settingsPath);
  }

  const registryBytes: ManagedFetch =
    options.fetchBytes ??
    ((url: string, signal: AbortSignal) => boundedRegistryDownload(url, 256 * 1024 * 1024, signal));

  const instances: ManagedToolInstance[] = MANAGED_TOOLS.filter((descriptor) =>
    descriptor.platforms.includes(process.platform),
  ).map((descriptor) => {
    const bundled = bundledDescriptorFor(descriptor);
    const root = join(rootDirectory, descriptor.tool);
    const state = { active: bundled, running: 0 };
    const updates = createManagedToolUpdates({
      currentVersion: existsSync(bundled.entrypoint) ? bundled.version : "0.0.0",
      check: async (signal) => {
        const upstream = await latestManagedToolRelease(
          descriptor.packageName,
          registryBytes,
          signal,
        );
        return resolveManagedToolRelease(descriptor, upstream, registryBytes, signal);
      },
      stage: (release, signal) =>
        stageManagedTool(descriptor, release, root, registryBytes, signal),
      isBusy: () => state.running > 0 || (options.isBusy?.() ?? false),
      activate: async (candidate) => {
        if (closed || state.running > 0) return false;
        // The staged tree must start before it replaces the installed release.
        // A tree that cannot start keeps the previous one.
        if (!(await smokeManagedTool(descriptor, candidate.entrypoint))) return false;
        if (!isInsideManagedToolLocation(root, candidate.path)) return false;
        await commitManagedTool(root, candidate);
        if (descriptor.runtime === "executable") await publishCurrentLink(root, candidate.version);
        state.active = candidate;
        return true;
      },
    });
    return { descriptor, bundled, root, updates, state };
  });

  /** Runs the staged entrypoint briefly: surviving past startup counts as runnable. */
  async function smokeManagedTool(
    descriptor: ManagedToolDescriptor,
    entrypoint: string,
  ): Promise<boolean> {
    if (closed) return false;
    if (descriptor.runtime === "executable") return smokeExecutable(entrypoint);
    return smokeNodeEntrypoint(descriptor.tool, entrypoint);
  }

  async function smokeExecutable(entrypoint: string): Promise<boolean> {
    return await new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      const child = spawn(entrypoint, ["--version"], {
        env: allowlistedEnvironment(),
        stdio: "ignore",
      });
      child.once("error", () => finish(false));
      child.once("exit", (code, signal) => {
        finish(code === 0 && signal === null);
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(false);
      }, options.smokeTimeoutMs ?? 3_000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    });
  }

  async function smokeNodeEntrypoint(tool: string, entrypoint: string): Promise<boolean> {
    const spec = await deviceLaunch(tool, entrypoint, []);
    if (spec === undefined) return false;
    return await new Promise<boolean>((resolvePromise) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      const child = spawn(spec.command, [...spec.args], {
        env: spec.env,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        stdio: "ignore",
      });
      child.once("error", () => finish(false));
      child.once("exit", (code, signal) => {
        // A clean exit (help text, argument refusal) means the tree loads; a
        // crash with a non-zero code or a signal does not.
        finish(code === 0 && signal === null);
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(true);
      }, options.smokeTimeoutMs ?? 3_000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    });
  }

  /** Relative link so a consented provider path keeps tracking the active release. */
  async function publishCurrentLink(root: string, version: string): Promise<void> {
    const temporary = join(root, `.current-link-${randomUUID()}`);
    await symlink(version, temporary);
    await rename(temporary, join(root, "current"));
  }

  /** A tool that is not in the app waits for an explicit Update before the first download. */
  function automaticFor(descriptor: ManagedToolDescriptor, installed: boolean): boolean {
    if (descriptor.shipInApp === false && !installed) return false;
    return settingsAutomaticUpdates;
  }

  async function initialize(): Promise<void> {
    initializing ??= (async () => {
      settingsAutomaticUpdates = await readSettings();
      for (const instance of instances) {
        const installed = await readInstalledManagedTool(instance.descriptor, instance.root);
        if (installed !== undefined) {
          instance.state.active = installed;
          instance.updates.restoreVerifiedVersion(installed.version);
          if (instance.descriptor.runtime === "executable")
            await publishCurrentLink(instance.root, installed.version);
        }
        instance.updates.configure({
          enabled: supported,
          automaticUpdates: automaticFor(instance.descriptor, installed !== undefined),
        });
      }
    })();
    await initializing;
  }

  function toolStatus(instance: ManagedToolInstance): ManagedToolStatus {
    const state: ManagedToolUpdateState = instance.updates.state();
    const message = launchFailures.get(instance.descriptor.tool) ?? state.message;
    const available = existsSync(instance.state.active.entrypoint);
    const stable = join(instance.root, "current", instance.descriptor.entrypoint);
    const managedExecutable =
      instance.descriptor.runtime === "executable" && existsSync(stable)
        ? stable
        : instance.descriptor.runtime === "executable" &&
            available &&
            isInsideManagedToolLocation(instance.root, instance.state.active.entrypoint)
          ? instance.state.active.entrypoint
          : undefined;
    return {
      tool: instance.descriptor.tool,
      packageName: instance.descriptor.packageName,
      channel: "npm",
      available,
      installed: instance.state.active.path !== instance.bundled.path,
      version: available ? instance.state.active.version : "0.0.0",
      update: state.status,
      ...(state.availableVersion === undefined ? {} : { availableVersion: state.availableVersion }),
      ...(message === undefined ? {} : { message }),
      ...(instance.descriptor.runtime === "executable" ? { managedDirectory: instance.root } : {}),
      ...(managedExecutable === undefined ? {} : { executablePath: managedExecutable }),
    };
  }

  return {
    /** Spawn arguments that run the tool's entrypoint under the desktop runtime. */
    launchSpec: async (
      tool: string,
      args: ReadonlyArray<string>,
      sdkRoot?: string,
    ): Promise<
      | { command: string; args: ReadonlyArray<string>; env: NodeJS.ProcessEnv; cwd?: string }
      | undefined
    > => {
      await initialize();
      const instance = instances.find((candidate) => candidate.descriptor.tool === tool);
      if (instance === undefined || closed || !existsSync(instance.state.active.entrypoint))
        return undefined;
      if (instance.descriptor.runtime === "executable") {
        return {
          command: instance.state.active.entrypoint,
          args,
          env: allowlistedEnvironment(),
        };
      }
      return await deviceLaunch(tool, instance.state.active.entrypoint, args, sdkRoot);
    },
    trackProcess: (tool: string, child: ChildProcess) => {
      const instance = instances.find((candidate) => candidate.descriptor.tool === tool);
      if (instance === undefined) return;
      instance.state.running += 1;
      trackedProcesses.add(child);
      child.once("exit", () => {
        trackedProcesses.delete(child);
        instance.state.running = Math.max(0, instance.state.running - 1);
        void instance.updates.applyWhenIdle();
      });
    },
    /**
     * Ends every tool process this service started, now. `close` waits for a
     * launch that has not printed its endpoint yet (up to its readiness window)
     * before it signals the process, so a quit that has run out of time uses
     * this instead: the process holds a port and would outlive the app.
     */
    terminateTrackedProcesses: (): void => {
      for (const child of trackedProcesses) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone; the exit handler drops it.
        }
      }
    },
    status: async (): Promise<ManagedToolsStatus> => {
      await initialize();
      return {
        supported,
        automaticUpdates: settingsAutomaticUpdates,
        tools: instances.map(toolStatus),
        ...(supported ? {} : { message: "Managed tools require the Octant desktop app." }),
      };
    },
    configure: async (next: { readonly automaticUpdates: boolean }) => {
      await initialize();
      if (settingsAutomaticUpdates === next.automaticUpdates) return;
      settingsAutomaticUpdates = next.automaticUpdates;
      for (const instance of instances) {
        const installed = instance.state.active.path !== instance.bundled.path;
        instance.updates.configure({
          enabled: supported,
          automaticUpdates: automaticFor(instance.descriptor, installed),
        });
      }
      await writeSettings();
    },
    checkUpdates: async (tool?: string): Promise<ManagedToolsStatus> => {
      await initialize();
      if (tool !== undefined && !MANAGED_TOOLS.some((descriptor) => descriptor.tool === tool))
        throw new TypeError("Invalid managed tool.");
      for (const instance of instances) {
        if (tool !== undefined && instance.descriptor.tool !== tool) continue;
        await instance.updates.check();
      }
      return {
        supported,
        automaticUpdates: settingsAutomaticUpdates,
        tools: instances.map(toolStatus),
        ...(supported ? {} : { message: "Managed tools require the Octant desktop app." }),
      };
    },
    close: () => {
      closing ??= (async () => {
        closed = true;
        let failed = false;
        for (const instance of instances) {
          try {
            await instance.updates.close();
          } catch {
            failed = true;
          }
        }
        // The owning desktop stops tracked tools before closing the service.
        // A live stream keeps its private state rather than losing it beneath its process.
        if (deviceState !== undefined && trackedProcesses.size === 0)
          await rm(await deviceState, { recursive: true, force: true });
        if (failed) throw new Error("Octant could not close managed-tool updaters.");
      })();
      return closing;
    },
  };
}
export type ManagedToolService = ReturnType<typeof createManagedToolService>;
