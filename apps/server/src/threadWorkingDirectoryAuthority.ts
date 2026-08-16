import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { ThreadWorkingDirectory } from "@octant/contracts";

export async function resolveThreadWorkingDirectory(
  authoritativeRoot: string,
  relativeDirectory: ThreadWorkingDirectory,
): Promise<string> {
  const canonicalRoot = await canonicalDirectory(authoritativeRoot, "root");
  const requested =
    relativeDirectory === "." ? canonicalRoot : resolve(canonicalRoot, relativeDirectory);
  const canonicalRequested = await canonicalDirectory(requested, "working directory");
  if (!isWithin(canonicalRoot, canonicalRequested)) {
    throw new Error("Thread working directory escapes its authoritative root.");
  }
  return canonicalRequested;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    return (await lstat(canonical)).isDirectory()
      ? canonical
      : Promise.reject(new Error(`Thread ${label} is unavailable.`));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Thread ")) throw error;
    throw new Error(`Thread ${label} is unavailable.`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith("../"));
}
