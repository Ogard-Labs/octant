import { join } from "node:path";
import type {
  ComputerControlCommand,
  ComputerUseOwner,
  ComputerUseSettings,
  ComputerUseStatus,
} from "@octant/contracts/computer-use-plugin";
import { createComputerUseControlHost } from "./computerUseControlHost";
import {
  createComputerUseDriverUpdates,
  type StagedComputerDriver,
} from "./computerUseDriverUpdates";
import {
  BUNDLED_CUA_DRIVER,
  commitComputerDriver,
  latestComputerDriverRelease,
  readInstalledComputerDriver,
  stageComputerDriver,
  verifyComputerDriverBinary,
} from "./computerUseDriverRelease";
import {
  computerUsePermissions,
  openComputerUsePermissionSettings,
  startComputerDriverRuntime,
  type ComputerDriverRuntime,
} from "./computerUseSdkRuntime";

export function createComputerUseDesktopService(options: {
  readonly bundledPath: string;
  readonly dataDirectory: string;
  readonly isWindowAvailable: (windowId: string) => boolean;
}) {
  const supported = process.platform === "darwin" && process.arch === "arm64";
  const versions = join(options.dataDirectory, "computer-use", "versions");
  const profileDirectory = join(options.dataDirectory, "computer-use", "profile");
  let settings: ComputerUseSettings = { enabled: false, automaticUpdates: false };
  let revision = 0;
  let active: StagedComputerDriver = {
    version: BUNDLED_CUA_DRIVER.version,
    path: options.bundledPath,
  };
  let runtime: ComputerDriverRuntime | undefined;
  let starting: Promise<ComputerDriverRuntime> | undefined;
  let initializing: Promise<void> | undefined;
  let state: ComputerUseStatus["driver"] = "unavailable";
  let replacing = false;
  let closed = false;
  const shutdown = new AbortController();

  async function initialize() {
    initializing ??= (async () => {
      if (!supported) return;
      active = (await readInstalledComputerDriver(versions)) ?? active;
      updates.restoreVerifiedVersion(active.version);
      try {
        await verifyComputerDriverBinary(active.path, active.version);
        state = "stopped";
      } catch {
        state = "unavailable";
      }
    })();
    await initializing;
  }
  const makeRuntime = (driver: StagedComputerDriver) =>
    startComputerDriverRuntime({
      driver,
      profileDirectory,
      signal: shutdown.signal,
      onExit: (generation) => {
        if (runtime?.generation !== generation) return;
        const ended = runtime;
        runtime = undefined;
        state = "failed";
        void controls.revokeAll().finally(() => ended.close());
      },
    });
  async function getRuntime(): Promise<ComputerDriverRuntime> {
    await initialize();
    if (closed || !supported || state === "unavailable")
      throw new Error("Computer use is unavailable.");
    if (runtime !== undefined) return runtime;
    starting ??= (async () => {
      state = "starting";
      try {
        runtime = await makeRuntime(active);
        state = "ready";
        return runtime;
      } catch (error) {
        state = "failed";
        throw error;
      }
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }
  const controls = createComputerUseControlHost({
    runtime: getRuntime,
    endSession: async (session) => {
      await runtime?.call("end_session", { session });
    },
    onIdle: () => {
      void updates.applyWhenIdle();
    },
  });
  const updates = createComputerUseDriverUpdates({
    currentVersion: active.version,
    check: latestComputerDriverRelease,
    stage: (release, signal) => stageComputerDriver(release, versions, signal),
    isBusy: () => controls.activeSessions() > 0 || replacing,
    activate: async (candidate) => {
      if (closed || replacing || !settings.enabled || controls.activeSessions() > 0) return false;
      replacing = true;
      const admittedRevision = revision;
      const previous = active;
      let replacement: ComputerDriverRuntime | undefined;
      try {
        await runtime?.close();
        runtime = undefined;
        replacement = await makeRuntime(candidate);
        if (closed || admittedRevision !== revision)
          throw new Error("Driver activation cancelled.");
        await commitComputerDriver(versions, candidate);
        active = candidate;
        runtime = replacement;
        state = "ready";
        return true;
      } catch {
        await replacement?.close().catch(() => undefined);
        if (!closed && settings.enabled) {
          try {
            runtime = await makeRuntime(previous);
            state = "ready";
          } catch {
            runtime = undefined;
            state = "failed";
          }
        }
        return false;
      } finally {
        replacing = false;
      }
    },
  });

  async function status(): Promise<ComputerUseStatus> {
    await initialize();
    const permissions = supported
      ? await computerUsePermissions().catch(() => ({
          accessibility: false,
          screenRecording: false,
        }))
      : { accessibility: false, screenRecording: false };
    const update = updates.state();
    return {
      supported,
      ...settings,
      permissions,
      driver: state,
      activeSessions: controls.activeSessions(),
      ...(state === "unavailable" ? {} : { version: active.version }),
      update: update.status,
      ...(update.availableVersion === undefined
        ? {}
        : { availableVersion: update.availableVersion }),
      ...(!supported
        ? { message: "Computer use requires the Apple Silicon macOS desktop app." }
        : state === "unavailable"
          ? { message: "The bundled computer-use driver is unavailable." }
          : !permissions.accessibility || !permissions.screenRecording
            ? {
                message:
                  "Allow Octant in macOS Accessibility and Screen Recording, then recheck. Some permission changes require relaunching Octant.",
              }
            : update.message === undefined
              ? {}
              : { message: update.message }),
    };
  }
  async function reserve(owner: ComputerUseOwner): Promise<boolean> {
    if (
      closed ||
      replacing ||
      !settings.enabled ||
      !options.isWindowAvailable(String(owner.windowId))
    )
      return false;
    const current = await status();
    if (
      closed ||
      replacing ||
      !settings.enabled ||
      !current.supported ||
      current.driver === "unavailable" ||
      !current.permissions.accessibility ||
      !current.permissions.screenRecording
    )
      return false;
    return controls.reserve(owner);
  }
  return {
    status,
    configure: async (next: ComputerUseSettings) => {
      if (settings.enabled === next.enabled && settings.automaticUpdates === next.automaticUpdates)
        return;
      revision += 1;
      settings = next;
      await initialize();
      updates.configure({
        enabled: supported && settings.enabled,
        automaticUpdates: settings.automaticUpdates,
      });
      if (!settings.enabled) {
        await controls.revokeAll();
        await runtime?.close();
        runtime = undefined;
        if (state !== "unavailable") state = "stopped";
      }
    },
    reserve,
    execute: async (
      owner: ComputerUseOwner,
      command: ComputerControlCommand,
      signal?: AbortSignal,
    ) => {
      if (command.operation === "stop") return controls.execute(owner, command, signal);
      if (!(await reserve(owner)))
        return {
          kind: "refused" as const,
          reason: "setup-required",
          message:
            "Computer use is unavailable. Open Computer use in Settings to check the plugin and macOS permissions.",
        };
      return controls.execute(owner, command, signal);
    },
    release: controls.release,
    requestPermissions: async () => {
      if (supported) await computerUsePermissions(true);
      return status();
    },
    openPermissionSettings: openComputerUsePermissionSettings,
    checkUpdates: async () => {
      if (supported) await updates.check();
      return status();
    },
    close: async () => {
      closed = true;
      shutdown.abort();
      await updates.close();
      await controls.close();
      await runtime?.close();
      runtime = undefined;
    },
  };
}
export type ComputerUseDesktopService = ReturnType<typeof createComputerUseDesktopService>;
