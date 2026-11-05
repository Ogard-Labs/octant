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
  desktopPeerPreflight,
  loadDesktopPeerStatus,
} from "./desktopPeerStatus";

// Identity and launch-role checks precede imports of the host-owning desktop.
const identity = app.isPackaged
  ? desktopIdentityForPackage(
      JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")),
    )
  : desktopIdentity("stable");

if (identity.flavor === "nightly" || (app.isPackaged && process.platform === "darwin")) {
  const role = resolvePackagedDesktopLaunch(identity, process.argv.slice(1));
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
    // Electron waits for ESM evaluation before ready. The signed client path
    // needs ready to create its window, so it must not hold this module open.
    void launchDesktop().catch(() => {
      void app.whenReady().then(() => {
        dialog.showErrorBox(
          identity.productName,
          "Octant Nightly could not open its authenticated client window.",
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

async function launchDesktop(): Promise<void> {
  if (identity.flavor === "nightly") {
    app.setName(identity.productName);
    const storage = desktopWindowStorageDirectory(identity, "", app.getPath("appData"));
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    app.setPath("userData", storage);
    app.setPath("sessionData", storage);
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
      const status = await desktopPeerPreflight(native);
      const closed = await closeDesktopPeerStatus(native);
      return closed.kind === "closed" ? status : { kind: "refused", reason: closed.reason };
    },
    async () => {
      const { runNightlyClient } = await import("./nightlyClient");
      return runNightlyClient(identity, native);
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
