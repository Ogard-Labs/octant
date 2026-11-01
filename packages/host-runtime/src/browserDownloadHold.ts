import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Where an agent's Browser holds the files a page downloaded, before the
 * person says whether the thread's workspace may have one. Each Browser keeps
 * its own folder, so one Browser starting never clears the other's held files.
 */
export type BrowserDownloadHoldKind = "headless" | "desktop";

const HOLD_KINDS: ReadonlyArray<BrowserDownloadHoldKind> = ["headless", "desktop"];

function holdParent(temporaryFolder: string): string {
  const owner = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(temporaryFolder, `octant-browser-downloads-${owner}`);
}

export function browserDownloadHoldRoot(
  kind: BrowserDownloadHoldKind,
  temporaryFolder: string = tmpdir(),
): string {
  return join(holdParent(temporaryFolder), kind);
}

/**
 * Empty and recreate a hold folder, private to this user. Called when a host
 * starts, so a file held by an earlier run, whose page and question are gone,
 * is never left behind.
 */
export async function prepareBrowserDownloadHoldRoot(
  kind: BrowserDownloadHoldKind,
  temporaryFolder: string = tmpdir(),
): Promise<string> {
  const parent = holdParent(temporaryFolder);
  const root = join(parent, kind);
  // The parent is checked before anything under it is removed: a link or a
  // folder someone else made in the shared temporary folder is not ours, and
  // removing a child through it would delete somewhere else.
  const existing = await lstat(parent).catch(() => undefined);
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
    await rm(parent, { recursive: true, force: true });
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stats = await lstat(parent);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new Error("The Browser's download folder is not private to this user.");
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { mode: 0o700 });
  return realpath(root);
}

/**
 * Whether a path lies inside one of the hold folders. The check is on the
 * resolved path, so a server asked to read a held file refuses anything a
 * runtime names outside them.
 */
export async function isInsideBrowserDownloadHold(
  path: string,
  temporaryFolder: string = tmpdir(),
): Promise<boolean> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch {
    return false;
  }
  for (const kind of HOLD_KINDS) {
    let root: string;
    try {
      root = await realpath(browserDownloadHoldRoot(kind, temporaryFolder));
    } catch {
      continue;
    }
    if (canonical.startsWith(`${root}${sep}`)) return true;
  }
  return false;
}
