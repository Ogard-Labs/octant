import { constants, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openConfinedPath, statConfinedPath } from "../confinedPathOpen";

/** Only ordinary repositories and Git's reciprocal linked-worktree records grant metadata access. */
export async function gitHistoryMetadata(root: string): Promise<ReadonlyArray<string> | undefined> {
  try {
    // The marker is in the agent-writable checkout, so it is examined only
    // through opens that land on its canonical path, and the reciprocity check
    // compares against that path rather than resolving the marker again. A
    // marker that passed a first look and was then swapped for a link made the
    // later reads and `realpath(marker)` follow it to another repository's
    // `.git` or linked-worktree marker, whose metadata was then granted.
    const canonicalRoot = await realpath(root);
    const marker = join(canonicalRoot, ".git");
    if ((await statConfinedPath(marker)).isDirectory()) return [marker];
    const pointer = await readGitPointer(marker);
    if (!pointer.startsWith("gitdir: ")) return undefined;
    const gitDirectory = await realpath(resolve(canonicalRoot, pointer.slice(8)));
    if (basename(dirname(gitDirectory)) !== "worktrees") return undefined;
    const backlink = await realpath(
      resolve(gitDirectory, await readGitPointer(join(gitDirectory, "gitdir"))),
    );
    if (backlink !== marker) return undefined;
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
  const file = await openConfinedPath(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
