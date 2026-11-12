import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog } from "electron";
import {
  decodeHostRecoveryAction,
  describeHostMaintenanceOutcome,
  hostMaintenanceSpawnSpec,
  hostRecoveryScreenFor,
  renderHostRecoveryDocument,
  type HostRecoveryOutcome,
  type HostRecoveryScreen,
  type HostStartupRefusal,
} from "./hostRecovery";

const MAINTENANCE_OUTPUT_LIMIT = 16_384;

/**
 * Shows the recovery screen for a refused start and resolves with what the
 * person chose: start the host again, or quit. Closing the window or quitting
 * from the menu is a quit.
 */
export async function showHostRecovery(options: {
  readonly refusal: HostStartupRefusal;
  readonly packaged: boolean;
  readonly root: string;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<"retry" | "quit"> {
  let screen: HostRecoveryScreen = hostRecoveryScreenFor(options.refusal);
  const window = new BrowserWindow({
    width: 600,
    height: 380,
    title: "Octant recovery",
    show: false,
    resizable: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: "octant-host-recovery",
    },
  });
  const render = async (state: {
    readonly busy?: boolean;
    readonly outcome?: HostRecoveryOutcome;
  }) => {
    if (window.isDestroyed()) return;
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(renderHostRecoveryDocument(screen, state))}`,
    );
  };
  return await new Promise<"retry" | "quit">((resolve) => {
    let settled = false;
    let busy = false;
    const finish = (choice: "retry" | "quit") => {
      if (settled) return;
      settled = true;
      app.removeListener("before-quit", quitFromMenu);
      if (!window.isDestroyed()) window.destroy();
      resolve(choice);
    };
    const quitFromMenu = () => finish("quit");
    app.on("before-quit", quitFromMenu);
    window.on("closed", () => finish("quit"));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const action = decodeHostRecoveryAction(url);
      if (action === undefined || busy) return;
      if (action === "retry" || action === "quit") {
        finish(action);
        return;
      }
      if (!screen.actions.includes(action)) return;
      busy = true;
      void (async () => {
        if (action === "restore" && !(await confirmRestore(window))) {
          busy = false;
          return;
        }
        await render({ busy: true });
        const outcome = await runMaintenance({ ...options, action });
        if (outcome.status === "repaired") screen = { ...screen, actions: ["retry", "quit"] };
        busy = false;
        await render({ outcome });
      })();
    });
    window.once("ready-to-show", () => window.show());
    void render({});
  });
}

async function confirmRestore(parent: BrowserWindow): Promise<boolean> {
  const answer = await dialog.showMessageBox(parent, {
    type: "warning",
    title: "Restore last backup",
    message: "Replace Octant's current data with its last verified backup?",
    detail:
      "Octant checks the backup before it uses it. Anything recorded after that backup was made will no longer be in Octant.",
    buttons: ["Cancel", "Restore backup"],
    defaultId: 0,
    cancelId: 0,
  });
  return answer.response === 1;
}

async function runMaintenance(options: {
  readonly packaged: boolean;
  readonly root: string;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly action: "rebuild" | "restore";
}): Promise<HostRecoveryOutcome> {
  const spec = hostMaintenanceSpawnSpec(options);
  return await new Promise<HostRecoveryOutcome>((resolve) => {
    let stderr = "";
    const child = spawn(spec.command, [...spec.args], {
      env: spec.env,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAINTENANCE_OUTPUT_LIMIT);
    });
    child.once("error", () => resolve(describeHostMaintenanceOutcome(options.action, null, "")));
    child.once("close", (code) =>
      resolve(describeHostMaintenanceOutcome(options.action, code, stderr)),
    );
  });
}
