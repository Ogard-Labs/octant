import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DESKTOP_PRELOAD_FILENAME = "preload.cjs" as const;
export const CODE_APPROVAL_PRELOAD_FILENAME = "code-approval-preload.cjs" as const;
export const CODE_FILE_HELPER_FILENAME = "octant-code-file-helper" as const;
export const KEYCHAIN_HELPER_FILENAME = "octant-keychain-helper" as const;
export const CUA_DRIVER_FILENAME = "cua-driver" as const;

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
    | typeof CUA_DRIVER_FILENAME,
): string {
  return options.packaged
    ? resolve(options.resourcesPath, "native", filename)
    : resolve(dirname(fileURLToPath(options.moduleUrl)), "native", filename);
}
