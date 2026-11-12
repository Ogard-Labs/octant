import { posix, win32 } from "node:path";

/**
 * A host path as the host compares it. Windows paths are case-insensitive and
 * Git for Windows writes them with forward slashes and whatever drive-letter
 * case the repository was opened with (`c:/Users/…` beside `C:\Users\…`), so
 * there a path is resolved with Windows rules and compared in lower case.
 * Elsewhere it is resolved and compared exactly.
 */
export function hostPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? win32.resolve(path).toLowerCase() : posix.resolve(path);
}

export function sameHostPath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return hostPathKey(a, platform) === hostPathKey(b, platform);
}
