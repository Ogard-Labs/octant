import { CANVAS_PROTOTYPE_HOST_SWITCH } from "./canvasPrototypeProtocol";
import {
  loadCanvasPrototypeHostRuntime,
  loadNightlyClientRuntime,
  loadTerminalLauncherRuntime,
} from "./desktopRuntimeLoader";
import { app } from "electron";
import { writeDiagnostic } from "./diagnosticLog";
import { showStartupFailureAndQuit } from "./startupFailureElectron";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  desktopIdentity,
  desktopIdentityForPackage,
  desktopWindowStorageDirectory,
} from "@octant/host-runtime/desktop-identity";
import { createWindowsDesktopLauncher } from "@octant/host-runtime/windows-desktop-launcher";
import {
  loadWindowsHostProfileNative,
  resolveWindowsHostProfile,
} from "@octant/host-runtime/windows-host-profile";
import { launchDesktopApplication, resolvePackagedDesktopLaunch } from "./desktopLaunch";
import {
  closeDesktopPeerStatus,
  ensureNightlyHostReady,
  linuxRendererSandboxDisabled,
  loadDesktopPeerStatus,
  type DesktopPeerStart,
} from "./desktopPeerStatus";
import { resolveDesktopHostRuntimePaths, WINDOWS_HOST_OWNER_FILENAME } from "./runtimePaths";
import { resolveStartupHostRole } from "./nightlyTestData";
import { createNightlyLaunchLinks } from "./nightlyLaunchLinks";

// Identity and launch-role checks precede imports of the host-owning desktop.
const identity = app.isPackaged
  ? desktopIdentityForPackage(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    )
  : desktopIdentity("stable");
const launchLinks = createNightlyLaunchLinks(identity.scheme);
let windowsHostOnlyLaunch = false;

if (
  identity.flavor === "nightly" ||
  (app.isPackaged &&
    (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"))
) {
  const role = resolvePackagedDesktopLaunch(
    identity,
    process.argv.slice(1),
    identity.flavor === "nightly"
      ? resolveStartupHostRole({
          identity,
          windowStorageDirectory: desktopWindowStorageDirectory(
            identity,
            "",
            app.getPath("appData"),
          ),
          appDataDirectory: app.getPath("appData"),
          platform: process.platform,
          env: process.env,
        })
      : undefined,
  );
  if (role.kind === "host-only" && process.platform === "win32") {
    windowsHostOnlyLaunch = true;
    process.stderr.write('{"windowsHostOnlyPhase":"entry-admitted"}\n');
  }
  if (role.kind === "refused") {
    process.stderr.write(`${role.message}\n`);
    app.exit(1);
  } else if (role.kind === "canvas") {
    await runCanvasPrototypeHostRuntime();
  } else if (role.kind === "terminal") {
    const { runTerminalLauncher } = await loadTerminalLauncherRuntime();
    const code = await runTerminalLauncher(role.args, {
      environment: process.env,
      input: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    app.exit(code);
  } else if (identity.flavor === "nightly") {
    // Registered before any await: a link that launched Nightly arrives while
    // the entry still checks Octant's host, and is not in argv to read later.
    app.on("open-url", (event, url) => {
      event.preventDefault();
      launchLinks.receive(url);
    });
    for (const argument of process.argv) launchLinks.receive(argument);
    // Electron waits for ESM evaluation before ready. The signed client path
    // needs ready to create its window, so it must not hold this module open.
    void launchDesktop().catch((error: unknown) => {
      const message =
        error instanceof NightlyTestHostFailure
          ? error.message
          : "Octant Nightly could not open its authenticated client window.";
      writeDiagnostic(`${identity.productName}: ${message}`);
      void showStartupFailureAndQuit({ title: identity.productName, message });
    });
  } else {
    await launchDesktop();
  }
} else if (process.argv.includes(CANVAS_PROTOTYPE_HOST_SWITCH)) {
  await runCanvasPrototypeHostRuntime();
} else {
  await launchDesktop();
}

class NightlyTestHostFailure extends Error {}

async function runCanvasPrototypeHostRuntime(): Promise<void> {
  // Electron must not emit ready until this runtime has configured its
  // private storage, resolver switches and privileged scheme. The runtime
  // returns after setup; painting starts later, when Electron is ready.
  const { runCanvasPrototypeHost } = await loadCanvasPrototypeHostRuntime();
  await runCanvasPrototypeHost();
}

async function launchDesktop(): Promise<void> {
  if (identity.flavor === "nightly") {
    app.setName(identity.productName);
    const storage = desktopWindowStorageDirectory(identity, "", app.getPath("appData"));
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    app.setPath("userData", storage);
    app.setPath("sessionData", storage);
    // With separate test data Nightly owns a host of its own through the same
    // host-owning desktop Octant runs; it never reads Octant's status or host.
    const role = resolveStartupHostRole({
      identity,
      windowStorageDirectory: storage,
      appDataDirectory: app.getPath("appData"),
      platform: process.platform,
      env: process.env,
    });
    if (role.kind === "test-host") {
      // The test host's own main claims its links.
      launchLinks.stop();
      try {
        await import(new URL("./main.mjs", import.meta.url).href);
      } catch (error) {
        throw new NightlyTestHostFailure(
          error instanceof Error && error.message.startsWith("Octant Nightly refused")
            ? error.message
            : "Octant Nightly could not start the host for its test data.",
        );
      }
      return;
    }
    // The client holds Nightly's single-instance lock in the same window
    // storage the test host locks, so a client and a test host never run
    // together; a second launch focuses the first, as Octant's does.
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
  }
  // A Nightly on these platforms whose renderers would run unsandboxed never reaches the
  // binding, so it neither starts Octant's host nor registers a window.
  const unsandboxed =
    identity.flavor === "nightly" &&
    (process.platform === "linux" || process.platform === "win32") &&
    linuxRendererSandboxDisabled({
      hasSwitch: (name) => app.commandLine.hasSwitch(name),
      argv: process.argv,
      env: process.env,
    });
  const windows = identity.flavor === "nightly" && !unsandboxed ? windowsPeerContext() : undefined;
  const native =
    identity.flavor === "nightly" && !unsandboxed
      ? loadDesktopPeerStatus({
          packaged: app.isPackaged,
          platform: process.platform,
          resourcesPath: process.resourcesPath,
          ...linuxPeerEndpoint(),
          ...(windows === undefined ? {} : { windows: windows.endpoint }),
        })
      : undefined;
  const outcome = await launchDesktopApplication(
    identity,
    async () => {
      const loaded = await import(new URL("./main.mjs", import.meta.url).href);
      if (windowsHostOnlyLaunch)
        process.stderr.write('{"windowsHostOnlyPhase":"main-evaluated"}\n');
      return loaded;
    },
    async () => {
      if (unsandboxed) return { kind: "refused", reason: "unsandboxed-renderer" };
      if (native === undefined) return { kind: "refused", reason: "native-unavailable" };
      const status = await ensureNightlyHostReady(
        windows === undefined
          ? native
          : {
              status: () => native.status(),
              launchStableHost: windows.launchStableHost,
            },
      );
      if (windows !== undefined)
        process.stderr.write(
          `${JSON.stringify({
            windowsNightlyHostPreflight: {
              status: status.kind,
              ...(status.kind === "refused" ? { reason: status.reason } : {}),
            },
          })}\n`,
        );
      const closed = await closeDesktopPeerStatus(native);
      return closed.kind === "closed" ? status : { kind: "refused", reason: closed.reason };
    },
    async () => {
      const { runNightlyClient } = await loadNightlyClientRuntime();
      return runNightlyClient(identity, native, launchLinks);
    },
  );
  if (outcome.kind === "client-bridge-required") {
    app.setName(identity.productName);
    app.setPath("userData", desktopWindowStorageDirectory(identity, "", app.getPath("appData")));
    writeDiagnostic(`${identity.productName}: ${outcome.message}`);
    void showStartupFailureAndQuit({ title: identity.productName, message: outcome.message });
  }
}

/** Octant's Linux window socket and launcher record, from Octant's own host paths. */
function linuxPeerEndpoint() {
  if (process.platform !== "linux" || !app.isPackaged) return {};
  try {
    const paths = resolveDesktopHostRuntimePaths(
      process.env.OCTANT_DATA_DIR,
      app.getPath("appData"),
      process.platform,
      process.env,
    );
    return {
      linux: {
        windowsSocketPath: paths.windowsSocketPath,
        launcherRecordPath: paths.launcherRecordPath,
        version: app.getVersion(),
      },
    };
  } catch {
    // Unresolvable host paths leave the binding unloaded: native-unavailable.
    return {};
  }
}

/** Metadata may be created; this never claims the host owner or opens its journal. */
function windowsPeerContext() {
  if (process.platform !== "win32" || !app.isPackaged) return undefined;
  const native = loadWindowsHostProfileNative(
    join(process.resourcesPath, "native", WINDOWS_HOST_OWNER_FILENAME),
  );
  if (native === undefined) return undefined;
  const profile = resolveWindowsHostProfile({ native, profile: "octant", env: process.env });
  if (profile.status !== "ready") return undefined;
  const launcher = createWindowsDesktopLauncher(native, profile.paths);
  return {
    endpoint: { profileId: profile.paths.profileId, version: app.getVersion() },
    launchStableHost: async (): Promise<DesktopPeerStart> => {
      if (launcher === undefined) return { kind: "refused", reason: "incompatible-host" };
      const outcome = await launcher.launch();
      // A later readiness timeout otherwise hides whether native launch refused
      // or a started host failed before publishing its private projection.
      process.stderr.write(`${JSON.stringify({ windowsNightlyHostLaunch: outcome })}\n`);
      return outcome.status === "started"
        ? { kind: "started" }
        : {
            kind: "refused",
            reason:
              outcome.status === "missing"
                ? "no-launcher-record"
                : outcome.reason === "deadline-exceeded"
                  ? "deadline-exceeded"
                  : "invalid-receipt",
          };
    },
  };
}
