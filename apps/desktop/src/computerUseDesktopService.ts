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
  computerDriverPermissions,
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
  let verification: NonNullable<ComputerUseStatus["verification"]> = "not-tested";
  let verificationMessage: string | undefined;
  let verifiedRuntime: ComputerDriverRuntime | undefined;
  let testing: AbortController | undefined;
  let testCompletion: Promise<unknown> | undefined;
  let replacing = false;
  let closed = false;
  let closing: Promise<void> | undefined;
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
    if (closed || !settings.enabled || !supported || state === "unavailable")
      throw new Error("Computer use is unavailable.");
    if (runtime !== undefined) return runtime;
    starting ??= (async () => {
      state = "starting";
      try {
        const started = await makeRuntime(active);
        if (closed || !settings.enabled) {
          await started.close();
          throw new Error("Computer use startup was cancelled.");
        }
        runtime = started;
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
    isBusy: () => controls.activeSessions() > 0 || replacing || testing !== undefined,
    activate: async (candidate) => {
      if (
        closed ||
        replacing ||
        testing !== undefined ||
        !settings.enabled ||
        controls.activeSessions() > 0
      )
        return false;
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
    const host = supported
      ? await computerUsePermissions().catch(() => ({
          accessibility: false,
          screenRecording: false,
        }))
      : { accessibility: false, screenRecording: false };
    // The driver, not Octant, acts, and macOS can refuse it while allowing
    // Octant. Report what the driver holds once Octant's own grants allow
    // starting it.
    const driver =
      settings.enabled &&
      !replacing &&
      state !== "unavailable" &&
      host.accessibility &&
      host.screenRecording
        ? await getRuntime().then(computerDriverPermissions, () => undefined)
        : undefined;
    const permissions = driver ?? host;
    if (
      verification === "passed" &&
      (!settings.enabled ||
        runtime !== verifiedRuntime ||
        state !== "ready" ||
        !permissions.accessibility ||
        !permissions.screenRecording)
    ) {
      verification = "not-tested";
      verifiedRuntime = undefined;
    }
    if (
      testing !== undefined &&
      (!settings.enabled || !permissions.accessibility || !permissions.screenRecording)
    )
      testing.abort();
    const update = updates.state();
    return {
      supported,
      ...settings,
      verification,
      ...(verificationMessage === undefined ? {} : { verificationMessage }),
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
          : state === "failed"
            ? {
                message:
                  "The bundled driver could not start. Relaunch the signed Octant app and recheck.",
              }
            : driver !== undefined && (!driver.accessibility || !driver.screenRecording)
              ? {
                  message:
                    "macOS allows Octant but refuses the computer-use driver it starts. This happens with unsigned Octant builds; install a signed Octant build, allow it in Accessibility and Screen Recording, then relaunch and recheck.",
                }
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
      testing !== undefined ||
      replacing ||
      !settings.enabled ||
      !options.isWindowAvailable(String(owner.windowId))
    )
      return false;
    const current = await status();
    if (
      closed ||
      testing !== undefined ||
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
      if (
        settings.enabled === next.enabled &&
        settings.automaticUpdates === next.automaticUpdates &&
        settings.setupPending === next.setupPending
      )
        return;
      revision += 1;
      settings = next;
      await initialize();
      updates.configure({
        enabled: supported && settings.enabled,
        automaticUpdates: settings.automaticUpdates,
      });
      if (!settings.enabled) {
        verification = "not-tested";
        verificationMessage = undefined;
        verifiedRuntime = undefined;
        testing?.abort();
        await testCompletion;
        await starting?.catch(() => undefined);
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
    test: async (
      run: (runtime: ComputerDriverRuntime, signal: AbortSignal) => Promise<boolean>,
    ) => {
      if (testing !== undefined) return status();
      const abort = new AbortController();
      testing = abort;
      const complete = async () => {
        try {
          const current = await status();
          if (
            closed ||
            replacing ||
            !settings.enabled ||
            !current.supported ||
            current.driver !== "ready" ||
            !current.permissions.accessibility ||
            !current.permissions.screenRecording
          )
            throw new Error(
              "Enable Computer use, allow both macOS permissions, then recheck before testing.",
            );
          if (controls.activeSessions() > 0)
            throw new Error("Wait for computer-use tasks to finish, then test again.");
          verification = "running";
          verificationMessage = undefined;
          const checkedRuntime = await getRuntime();
          const signal = AbortSignal.any([
            abort.signal,
            shutdown.signal,
            AbortSignal.timeout(60_000),
          ]);
          const passed = await run(checkedRuntime, signal);
          signal.throwIfAborted();
          const permissions = await computerDriverPermissions(checkedRuntime);
          signal.throwIfAborted();
          if (
            runtime !== checkedRuntime ||
            !settings.enabled ||
            !permissions.accessibility ||
            !permissions.screenRecording
          )
            throw new Error(
              "Computer use changed during the test. Recheck permissions and test again.",
            );
          verification = passed ? "passed" : "not-tested";
          verifiedRuntime = passed ? checkedRuntime : undefined;
          verificationMessage = passed
            ? undefined
            : "Test cancelled. You can test again when ready.";
        } catch (error) {
          verification = settings.enabled ? "failed" : "not-tested";
          verifiedRuntime = undefined;
          verificationMessage =
            abort.signal.aborted || shutdown.signal.aborted
              ? "Test cancelled. Recheck permissions and retry."
              : error instanceof Error
                ? error.message.slice(0, 1_024)
                : "The test failed. Recheck permissions and retry.";
        } finally {
          testing = undefined;
          void updates.applyWhenIdle();
        }
      };
      testCompletion = complete();
      await testCompletion;
      return status();
    },
    requestPermissions: async () => {
      if (supported) await computerUsePermissions(true);
      return status();
    },
    openPermissionSettings: openComputerUsePermissionSettings,
    checkUpdates: async () => {
      if (supported) await updates.check();
      return status();
    },
    close: () => {
      closing ??= (async () => {
        closed = true;
        shutdown.abort();
        testing?.abort();
        await testCompletion;
        await starting?.catch(() => undefined);
        let failed = false;
        try {
          await updates.close();
        } catch {
          failed = true;
        }
        try {
          await controls.close();
        } catch {
          failed = true;
        }
        try {
          await runtime?.close();
          runtime = undefined;
        } catch {
          failed = true;
        }
        if (failed) throw new Error("Octant could not close computer-use resources.");
      })();
      return closing;
    },
  };
}
export type ComputerUseDesktopService = ReturnType<typeof createComputerUseDesktopService>;
