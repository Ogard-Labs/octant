import { CANVAS_PROTOTYPE_HOST_SWITCH, runCanvasPrototypeHost } from "./canvasPrototypeHost";
import { app, dialog } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  desktopIdentity,
  desktopIdentityForPackage,
  desktopWindowStorageDirectory,
} from "@octant/host-runtime";
import { launchDesktopApplication, resolvePackagedDesktopLaunch } from "./desktopLaunch";
import {
  closeDesktopPeerStatus,
  ensureNightlyHostReady,
  loadDesktopPeerStatus,
} from "./desktopPeerStatus";
import { resolveStartupHostRole } from "./nightlyTestData";
import { createNightlyLaunchLinks } from "./nightlyLaunchLinks";

// Identity and launch-role checks precede imports of the host-owning desktop.
const identity = app.isPackaged
  ? desktopIdentityForPackage(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    )
  : desktopIdentity("stable");
const launchLinks = createNightlyLaunchLinks(identity.scheme);

if (identity.flavor === "nightly" || (app.isPackaged && process.platform === "darwin")) {
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
  if (role.kind === "refused") {
    process.stderr.write(`${role.message}\n`);
    app.exit(1);
  } else if (role.kind === "canvas") {
    void runCanvasPrototypeHost();
  } else if (role.kind === "terminal") {
    const { runTerminalLauncher } = await import("@octant/cli/terminal-launcher");
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
      void app.whenReady().then(() => {
        dialog.showErrorBox(
          identity.productName,
          error instanceof NightlyTestHostFailure
            ? error.message
            : "Octant Nightly could not open its authenticated client window.",
        );
        app.quit();
      });
    });
  } else {
    await launchDesktop();
  }
} else if (process.argv.includes(CANVAS_PROTOTYPE_HOST_SWITCH)) {
  void runCanvasPrototypeHost();
} else {
  await launchDesktop();
}

class NightlyTestHostFailure extends Error {}

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
  const native =
    identity.flavor === "nightly"
      ? loadDesktopPeerStatus({
          packaged: app.isPackaged,
          platform: process.platform,
          resourcesPath: process.resourcesPath,
        })
      : undefined;
  const outcome = await launchDesktopApplication(
    identity,
    () => import(new URL("./main.mjs", import.meta.url).href),
    async () => {
      if (native === undefined) return { kind: "refused", reason: "native-unavailable" };
      const status = await ensureNightlyHostReady(native);
      const closed = await closeDesktopPeerStatus(native);
      return closed.kind === "closed" ? status : { kind: "refused", reason: closed.reason };
    },
    async () => {
      const { runNightlyClient } = await import("./nightlyClient");
      return runNightlyClient(identity, native, launchLinks);
    },
  );
  if (outcome.kind === "client-bridge-required") {
    app.setName(identity.productName);
    app.setPath("userData", desktopWindowStorageDirectory(identity, "", app.getPath("appData")));
    void app.whenReady().then(() => {
      dialog.showErrorBox(identity.productName, outcome.message);
      app.quit();
    });
  }
}
