import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Only ordinary repositories and Git's reciprocal linked-worktree records grant metadata access. */
export async function gitHistoryMetadata(root: string): Promise<ReadonlyArray<string> | undefined> {
  try {
    const marker = join(root, ".git");
    const stat = await lstat(marker);
    if (stat.isSymbolicLink()) return undefined;
    if (stat.isDirectory()) return [await realpath(marker)];
    if (!stat.isFile()) return undefined;
    const pointer = await readGitPointer(marker);
    if (!pointer.startsWith("gitdir: ")) return undefined;
    const gitDirectory = await realpath(resolve(root, pointer.slice(8)));
    if (basename(dirname(gitDirectory)) !== "worktrees") return undefined;
    const backlink = await realpath(
      resolve(gitDirectory, await readGitPointer(join(gitDirectory, "gitdir"))),
    );
    if (backlink !== (await realpath(marker))) return undefined;
    const commonDirectory = await realpath(
      resolve(gitDirectory, await readGitPointer(join(gitDirectory, "commondir"))),
    );
    if (commonDirectory !== dirname(dirname(gitDirectory))) return undefined;
    return [gitDirectory, commonDirectory];
  } catch {
    return undefined;
  }
}

async function readGitPointer(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid Git metadata pointer");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Oversized Git metadata pointer");
    return bytes.subarray(0, bytesRead).toString("utf8").trimEnd();
  } finally {
    await file.close();
  }
}
