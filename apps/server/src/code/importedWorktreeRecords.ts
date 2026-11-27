import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostPathKey } from "./hostPaths";

/**
 * What a purge leaves behind of a worktree imported from Octant: a record
 * that the folder is Octant's checkout, so Disk cleanup still refuses it once
 * the thread and its receipt are gone. Only a digest of the folder's path is
 * kept, never the path, because the path ends in the purged thread's id and a
 * purge leaves no trace of the thread (docs/design/nightly-app.md#importing-from-octant).
 */
const RECORDS_DIRECTORY = "octant-imported-worktrees";

export function importedWorktreeKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash("sha256")
    .update("octant.imported-worktree.v1\0")
    .update(hostPathKey(path, platform))
    .digest("hex");
}

export async function keepImportedWorktreeRecord(
  dataDirectory: string,
  path: string,
): Promise<void> {
  const directory = join(dataDirectory, RECORDS_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, importedWorktreeKey(path)), "", { mode: 0o600 });
}

export async function readImportedWorktreeKeys(
  dataDirectory: string,
): Promise<ReadonlySet<string>> {
  let names: string[];
  try {
    names = await readdir(join(dataDirectory, RECORDS_DIRECTORY));
  } catch (error) {
    // No record yet; any other failure stops Disk cleanup rather than let it
    // offer a folder it cannot tell is Octant's.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
  return new Set(names.filter((name) => /^[0-9a-f]{64}$/.test(name)));
}
