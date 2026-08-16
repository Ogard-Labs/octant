import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  prepareHostRuntimePaths,
  resolveHostRuntimePaths,
  type HostRuntimePaths,
} from "@octant/host-runtime";

export interface StorePathInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly temporaryDirectory?: string;
  readonly uid?: number;
}

export function resolveDataDirectory(input: StorePathInput): string {
  return resolveRuntimePaths(input).dataDirectory;
}

export async function prepareStore(input: StorePathInput): Promise<{
  readonly directory: string;
  readonly databasePath: string;
}> {
  const paths = resolveRuntimePaths(input);
  await prepareHostRuntimePaths(paths);
  const directory = paths.dataDirectory;
  return {
    directory,
    databasePath: join(directory, "octant.sqlite3"),
  };
}

function resolveRuntimePaths(input: StorePathInput): HostRuntimePaths {
  return resolveHostRuntimePaths({
    env: input.env,
    platform: input.platform,
    home: input.home,
    temporaryDirectory: input.temporaryDirectory ?? canonicalTemporaryDirectory(),
    uid: input.uid ?? process.getuid?.() ?? 0,
  });
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}

/**
 * Filesystem confinement: a destructive or backup operation may only touch a
 * path inside the resolved Octant data directory. This keeps a reset,
 * removal, or restore from ever reaching an unrelated repository, another
 * store, or any user path outside the confined directory.
 */
export function isPathWithinDirectory(directory: string, candidate: string): boolean {
  const resolvedDirectory = resolve(directory);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedDirectory) return true;
  const relativePath = relative(resolvedDirectory, resolvedCandidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
