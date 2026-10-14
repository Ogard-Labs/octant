import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_PRELOAD_FILENAME = "preload.cjs" as const;
export const CODE_APPROVAL_PRELOAD_FILENAME = "codeOperationApprovalViewPreload.cjs" as const;
export const CANVAS_PROTOTYPE_PRELOAD_FILENAME = "canvasPrototypePreload.cjs" as const;
export const CODE_FILE_HELPER_FILENAME = "octant-code-file-helper" as const;
export const KEYCHAIN_HELPER_FILENAME = "octant-keychain-helper" as const;
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
