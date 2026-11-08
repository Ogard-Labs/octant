import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostRuntimePaths, type HostRuntimePaths } from "@octant/host-runtime";

export const BROWSER_EDITABLE_PRELOAD_FILENAME = "browserEditablePreload.cjs" as const;
export const DESKTOP_PRELOAD_FILENAME = "preload.cjs" as const;
export const CODE_APPROVAL_PRELOAD_FILENAME = "codeOperationApprovalViewPreload.cjs" as const;
export const CANVAS_PROTOTYPE_PRELOAD_FILENAME = "canvasPrototypePreload.cjs" as const;
export const EXTENSION_BRIDGE_PRELOAD_FILENAME = "extensionBridgePreload.cjs" as const;
export const CODE_FILE_HELPER_FILENAME = "octant-code-file-helper" as const;
export const WINDOWS_CREDENTIAL_HELPER_FILENAME = "octant-credential-helper.exe" as const;
export const KEYCHAIN_HELPER_FILENAME = "octant-keychain-helper" as const;
export const WINDOWS_HOST_OWNER_FILENAME = "octant-windows-host-owner.node" as const;
export const DEVICE_HELPER_FILENAME = "octant-device-helper" as const;
export const CUA_DRIVER_FILENAME = "cua-driver" as const;
/**
 * The folder under the app's resources holding the terminal's `octant`
 * launcher (`octant mcp` only). Nothing else may live in it: the host puts the
 * whole folder on a Browser-granted terminal's `PATH`.
 */
export const TERMINAL_LAUNCHER_DIRECTORY_NAME = "terminal-launcher" as const;

export interface DesktopNativeHelperPathOptions {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly moduleUrl: string;
}

export function resolveDesktopNativeHelperPath(
  options: DesktopNativeHelperPathOptions,
  filename:
    | typeof CODE_FILE_HELPER_FILENAME
    | typeof KEYCHAIN_HELPER_FILENAME
    | typeof WINDOWS_HOST_OWNER_FILENAME
    | typeof WINDOWS_CREDENTIAL_HELPER_FILENAME
    | typeof DEVICE_HELPER_FILENAME
    | typeof CUA_DRIVER_FILENAME,
): string {
  return options.packaged
    ? resolve(options.resourcesPath, "native", filename)
    : resolve(dirname(fileURLToPath(options.moduleUrl)), "native", filename);
}

/** Directory holding every vendored managed-tool package tree for this host. */
export function resolveManagedToolsDirectory(options: DesktopNativeHelperPathOptions): string {
  return options.packaged
    ? resolve(options.resourcesPath, "managed-tools")
    : resolve(dirname(fileURLToPath(options.moduleUrl)), "managed-tools");
}

/**
 * The terminal launcher folder of a packaged app. A development run ships none:
 * the launcher runs with the packaged app's own runtime, and a source checkout
 * already has the full `octant` command.
 */
export function resolveTerminalLauncherDirectory(
  options: Omit<DesktopNativeHelperPathOptions, "moduleUrl">,
): string | undefined {
  return options.packaged
    ? resolve(options.resourcesPath, TERMINAL_LAUNCHER_DIRECTORY_NAME)
    : undefined;
}

export const DESKTOP_NODE_RUNTIME_NAME = "Octant Runtime";
export const DESKTOP_NODE_RUNTIME_BUNDLE_ID = "app.octant.desktop.runtime";
export const DESKTOP_NODE_RUNTIME_APP = `Contents/Frameworks/${DESKTOP_NODE_RUNTIME_NAME}.app`;

/** Executable scripts remain workers; their identity must never attest a desktop main. */
export function resolveDesktopNodeRuntime(options: {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly execPath: string;
}): string {
  return options.packaged && options.platform === "darwin"
    ? resolve(
        options.resourcesPath,
        "..",
        "Frameworks",
        `${DESKTOP_NODE_RUNTIME_NAME}.app`,
        "Contents/MacOS",
        DESKTOP_NODE_RUNTIME_NAME,
      )
    : options.execPath;
}

/** Node-mode workers read physical host files, not Electron's ASAR filesystem. */
export function resolveDesktopHostRoot(options: {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly appRoot: string;
}): string {
  return options.packaged && options.platform === "darwin"
    ? resolve(options.resourcesPath, "app")
    : options.appRoot;
}

export const DESKTOP_PEER_STATUS_FILENAME = "octant-desktop-peer-status.node";
/** The Linux binding: same exports, a path socket and kernel peer checks. */
export const DESKTOP_PEER_LINUX_FILENAME = "octant-desktop-peer-linux.node";
export const BROWSER_TEXT_INPUT_FILENAME = "octant-browser-text-input.node";

/**
 * The host paths Octant's desktop resolves for its data folder. Nightly's
 * client computes the same paths to reach the Linux window socket and
 * launcher record that Octant writes beside its control socket.
 */
export function resolveDesktopHostRuntimePaths(
  configuredDirectory: string | undefined,
  appDataDirectory: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostRuntimePaths {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Octant desktop does not support host paths on ${platform}.`);
  }
  // Electron appData is ~/Library/Application Support on macOS and ~/.config on
  // Linux; walk up to the home directory from that path so tests can inject a
  // synthetic appData without depending on the process home.
  const home =
    platform === "darwin" ? resolve(appDataDirectory, "..", "..") : resolve(appDataDirectory, "..");
  return resolveHostRuntimePaths({
    env: {
      OCTANT_DATA_DIR: configuredDirectory,
      // Linux XDG overrides must reach the host-runtime resolver; otherwise a
      // user with XDG_DATA_HOME set still lands under the default home path.
      XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: env.XDG_STATE_HOME,
      OCTANT_LOGS_DIR: env.OCTANT_LOGS_DIR,
    },
    platform,
    home,
    temporaryDirectory: canonicalTemporaryDirectory(),
    uid: process.getuid?.() ?? 0,
  });
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}
