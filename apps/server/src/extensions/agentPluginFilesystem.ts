import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  AgentPluginsError,
  fail,
  loadAgentPluginFromEntries,
  looksLikeAgentPlugin,
  type AgentPluginsPackageEntry,
  type LoadedAgentPlugin,
} from "@octant/plugin-host/agent-plugins";

const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1_024 * 1_024;

export interface LoadAgentPluginDirectoryOptions {
  readonly maximumEntries?: number;
  readonly maximumFileBytes?: number;
  readonly maximumTotalBytes?: number;
}

export interface LoadedAgentPluginDirectory {
  readonly pluginRoot: string;
  readonly entries: ReadonlyArray<AgentPluginsPackageEntry>;
  readonly plugin: LoadedAgentPlugin;
  readonly archiveBytes: number;
}

/**
 * Load an Agent Plugin from a real filesystem directory.
 * Enforces filesystem-resolved containment: every package path must remain
 * inside the realpath-resolved plugin root after resolving symlinks.
 */
export async function loadAgentPluginDirectory(
  directoryPath: string,
  options: LoadAgentPluginDirectoryOptions = {},
): Promise<LoadedAgentPluginDirectory> {
  const maximumEntries = options.maximumEntries ?? DEFAULT_MAX_ENTRIES;
  const maximumFileBytes = options.maximumFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maximumTotalBytes = options.maximumTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const pluginRoot = await resolvePluginRoot(directoryPath);
  const entries: AgentPluginsPackageEntry[] = [];
  let totalBytes = 0;
  let entryCount = 0;

  await walk(pluginRoot, pluginRoot, async (absolutePath, relativePath, stats) => {
    entryCount += 1;
    if (entryCount > maximumEntries) {
      fail("archive-oversize", "Package entry count exceeds the allowed limit.");
    }
    if (stats.isSymbolicLink()) {
      const target = await realpath(absolutePath);
      if (!isWithin(pluginRoot, target)) {
        fail("unsafe-path", `Package symlink escapes the plugin root: ${relativePath}`);
      }
      return;
    }
    if (stats.isDirectory()) {
      entries.push({ path: relativePath, kind: "directory" });
      return;
    }
    if (!stats.isFile()) {
      fail("entry-invalid", `Unsupported package entry kind at ${relativePath}`);
    }
    if (stats.size > maximumFileBytes) {
      fail("file-oversize", `Package file exceeds the allowed limit: ${relativePath}`);
    }
    const content = await readVerifiedPluginFile(
      pluginRoot,
      absolutePath,
      relativePath,
      stats,
      maximumFileBytes,
    );
    totalBytes += content.byteLength;
    if (totalBytes > maximumTotalBytes) {
      fail("archive-oversize", "Package extracted content exceeds the allowed limit.");
    }
    entries.push({ path: relativePath, kind: "file", content });
  });

  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (!looksLikeAgentPlugin(entries)) {
    fail(
      "manifest-schema",
      "Directory is not an Agent Plugins package (missing root plugin.json with supported $schema).",
    );
  }
  const plugin = loadAgentPluginFromEntries(entries);
  return { pluginRoot, entries, plugin, archiveBytes: totalBytes };
}

export function localPluginSourceRefForPath(canonicalPath: string): string {
  const digest = createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32);
  return `local-${digest}`;
}

/**
 * Open and read the exact regular file discovered by the directory walk.
 * O_NOFOLLOW binds the final component, while the descriptor/path snapshots
 * reject parent-directory swaps before any bytes can leave the plugin root.
 */
export async function readVerifiedPluginFile(
  pluginRoot: string,
  absolutePath: string,
  relativePath: string,
  discovered: Stats,
  maximumFileBytes: number,
): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("unsafe-path", `Package file changed or became a symlink: ${relativePath}`);
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(discovered, opened)) {
      fail("unsafe-path", `Package file changed during import: ${relativePath}`);
    }
    if (opened.size > maximumFileBytes) {
      fail("file-oversize", `Package file exceeds the allowed limit: ${relativePath}`);
    }

    const canonical = await realpath(absolutePath);
    const current = await lstat(absolutePath);
    if (!isWithin(pluginRoot, canonical) || !sameFileSnapshot(opened, current)) {
      fail("unsafe-path", `Package file escaped or changed during import: ${relativePath}`);
    }

    const content = await readBoundedFileHandle(handle, maximumFileBytes, relativePath);
    const after = await handle.stat();
    const currentAfter = await lstat(absolutePath);
    if (!sameFileSnapshot(opened, after) || !sameFileSnapshot(opened, currentAfter)) {
      fail("unsafe-path", `Package file changed during import: ${relativePath}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readBoundedFileHandle(
  handle: FileHandle,
  maximumFileBytes: number,
  relativePath: string,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maximumFileBytes) {
    const remaining = maximumFileBytes + 1 - total;
    if (remaining <= 0) break;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumFileBytes) {
      fail("file-oversize", `Package file exceeds the allowed limit: ${relativePath}`);
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function resolvePluginRoot(directoryPath: string): Promise<string> {
  if (typeof directoryPath !== "string" || directoryPath.trim() === "") {
    fail("unsafe-path", "Plugin directory path is required.");
  }
  try {
    const resolved = resolve(directoryPath);
    const canonical = await realpath(resolved);
    const stats = await lstat(canonical);
    if (!stats.isDirectory()) {
      fail("unsafe-path", "Plugin root must be a directory.");
    }
    return canonical;
  } catch (error) {
    if (error instanceof AgentPluginsError) throw error;
    fail("unsafe-path", "Plugin directory could not be resolved.");
  }
}

async function walk(
  root: string,
  current: string,
  visit: (absolutePath: string, relativePath: string, stats: Stats) => Promise<void>,
): Promise<void> {
  const children = await readdir(current, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (child.name === "." || child.name === "..") continue;
    const absolutePath = join(current, child.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (relativePath === "" || relativePath.startsWith("..")) {
      fail("unsafe-path", "Package walk escaped the plugin root.");
    }
    const stats = await lstat(absolutePath);
    await visit(absolutePath, relativePath, stats);
    if (stats.isDirectory()) {
      const canonical = await realpath(absolutePath);
      if (!isWithin(root, canonical)) {
        fail("unsafe-path", `Package directory escapes the plugin root: ${relativePath}`);
      }
      await walk(root, absolutePath, visit);
    } else if (stats.isFile()) {
      const canonical = await realpath(absolutePath);
      if (!isWithin(root, canonical)) {
        fail("unsafe-path", `Package file escapes the plugin root: ${relativePath}`);
      }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}
