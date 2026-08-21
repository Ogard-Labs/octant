import { classifyPathContainment, classifySymlinkContainment } from "@octant/domain";
import {
  liveCodeDirectoryPort,
  liveCodeTestSourcePort,
  type CodeDirectoryPort,
  type CodeDirectoryStat,
  type CodeTestSourcePort,
} from "./code/codeDirectoryPort";
import {
  joinCodePath,
  parentCodePath,
  readContainedDirectoryNames,
  resolveContainedPath,
} from "./code/codePathConfinement";
import { decodeFileMentionPath, type FileMentionCandidate } from "@octant/contracts";

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);
const MAX_LISTING_ENTRIES = 1_000;
const MAX_LISTING_DEPTH = 12;

export type FileMentionLocation =
  | {
      readonly kind: "file";
      readonly canonicalPath: string;
      readonly device: string;
      readonly inode: string;
      readonly size: number;
    }
  | { readonly kind: "directory"; readonly canonicalPath: string }
  | { readonly kind: "missing" }
  | { readonly kind: "escapes-root" };

/**
 * Filesystem port the file-mention surface uses after the relative path has
 * already been classified in-root. `locate` must not read file bytes;
 * `readBytes` is the only method that may.
 */
export interface FileMentionRootIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface FileMentionIo {
  locate(
    rootPath: string,
    relativePath: string,
    rootIdentity?: FileMentionRootIdentity,
  ): Promise<FileMentionLocation>;
  readBytes(
    canonicalPath: string,
    expected: { readonly device: string; readonly inode: string },
    maximumBytes: number,
  ): Promise<Uint8Array | undefined>;
  list(
    rootPath: string,
    rootIdentity?: FileMentionRootIdentity,
  ): Promise<ReadonlyArray<FileMentionCandidate>>;
}

/**
 * Capture the directory occupying `rootPath` so later mention IO can refuse a
 * swap onto the same name. A symlink or non-directory is unavailable rather
 * than followed.
 */
export async function pinFileMentionRoot(
  rootPath: string,
  directory: CodeDirectoryPort = liveCodeDirectoryPort,
): Promise<
  | {
      readonly kind: "ok";
      readonly rootPath: string;
      readonly rootIdentity: FileMentionRootIdentity;
    }
  | { readonly kind: "unavailable" }
> {
  let metadata: CodeDirectoryStat;
  try {
    metadata = await directory.lstat(rootPath);
  } catch {
    return { kind: "unavailable" };
  }
  if (metadata.isSymbolicLink || !metadata.isDirectory) {
    return { kind: "unavailable" };
  }
  return {
    kind: "ok",
    rootPath,
    rootIdentity: { device: metadata.device, inode: metadata.inode },
  };
}

export function createFileMentionIo(
  directory: CodeDirectoryPort = liveCodeDirectoryPort,
  files: CodeTestSourcePort = liveCodeTestSourcePort,
): FileMentionIo {
  return {
    async locate(rootPath, relativePath, rootIdentity) {
      const canonicalRoot = await canonicalizeMentionRoot(directory, rootPath, rootIdentity);
      if (canonicalRoot === undefined) return { kind: "missing" };
      if (classifyPathContainment(canonicalRoot, canonicalRoot) === "escapes-root") {
        return { kind: "escapes-root" };
      }
      const absolute = joinCodePath(canonicalRoot, relativePath);
      try {
        const linkStat = await directory.lstat(absolute);
        if (linkStat.isSymbolicLink) {
          const target = await directory.readlink(absolute);
          const resolvedTarget = await directory.realpath(
            target.startsWith("/") ? target : joinCodePath(parentCodePath(absolute), target),
          );
          if (classifySymlinkContainment(canonicalRoot, resolvedTarget) === "escapes-root") {
            return { kind: "escapes-root" };
          }
        }
      } catch {
        return { kind: "missing" };
      }
      const contained = await resolveContainedPath(directory, canonicalRoot, absolute);
      if (contained === undefined) return { kind: "missing" };
      if (contained.stat.isDirectory) {
        return { kind: "directory", canonicalPath: contained.canonical };
      }
      if (!contained.stat.isFile) return { kind: "missing" };
      return {
        kind: "file",
        canonicalPath: contained.canonical,
        device: contained.stat.device,
        inode: contained.stat.inode,
        size: contained.stat.size,
      };
    },
    async readBytes(canonicalPath, expected, maximumBytes) {
      let file;
      try {
        file = await files.openFile(canonicalPath);
      } catch {
        return undefined;
      }
      try {
        const opened = await file.stat();
        if (!opened.isFile) return undefined;
        if (opened.device !== expected.device || opened.inode !== expected.inode) return undefined;
        const toRead = Math.min(opened.size, maximumBytes);
        const bytes = await file.read(toRead);
        if (bytes.byteLength !== toRead) return undefined;
        return bytes;
      } catch {
        return undefined;
      } finally {
        await file.close().catch(() => undefined);
      }
    },
    async list(rootPath, rootIdentity) {
      const canonicalRoot = await canonicalizeMentionRoot(directory, rootPath, rootIdentity);
      if (canonicalRoot === undefined) return [];
      if (classifyPathContainment(canonicalRoot, canonicalRoot) === "escapes-root") return [];
      const root = await resolveContainedPath(directory, canonicalRoot, canonicalRoot);
      if (root === undefined || !root.stat.isDirectory) return [];
      const entries: FileMentionCandidate[] = [];
      await walk({
        directory,
        canonicalRoot,
        absolute: root.canonical,
        identity: root.stat,
        relative: "",
        depth: 0,
        entries,
        visited: new Set([root.canonical]),
      });
      return entries;
    },
  };
}

async function canonicalizeMentionRoot(
  directory: CodeDirectoryPort,
  rootPath: string,
  rootIdentity: FileMentionRootIdentity | undefined,
): Promise<string | undefined> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await directory.realpath(rootPath);
  } catch {
    return undefined;
  }
  if (rootIdentity === undefined) return canonicalRoot;
  let stat: CodeDirectoryStat;
  try {
    stat = await directory.stat(canonicalRoot);
  } catch {
    return undefined;
  }
  if (stat.device !== rootIdentity.device || stat.inode !== rootIdentity.inode) {
    return undefined;
  }
  return canonicalRoot;
}

async function walk(input: {
  readonly directory: CodeDirectoryPort;
  readonly canonicalRoot: string;
  readonly absolute: string;
  readonly identity: CodeDirectoryStat;
  readonly relative: string;
  readonly depth: number;
  readonly entries: FileMentionCandidate[];
  readonly visited: Set<string>;
}): Promise<void> {
  // Breadth-first so an early dense directory cannot exhaust the global
  // listing budget before sibling files at the same depth are recorded.
  const queue: Array<{
    readonly absolute: string;
    readonly identity: CodeDirectoryStat;
    readonly relative: string;
    readonly depth: number;
  }> = [
    {
      absolute: input.absolute,
      identity: input.identity,
      relative: input.relative,
      depth: input.depth,
    },
  ];
  while (queue.length > 0 && input.entries.length < MAX_LISTING_ENTRIES) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth > MAX_LISTING_DEPTH) continue;
    const names = await readContainedDirectoryNames(
      input.directory,
      current.absolute,
      current.identity,
      MAX_LISTING_ENTRIES - input.entries.length + 1,
    );
    if (names === undefined) continue;
    for (const name of names) {
      if (input.entries.length >= MAX_LISTING_ENTRIES) return;
      if (name === "." || name === ".." || SKIPPED_DIRECTORIES.has(name)) continue;
      const relative = current.relative === "" ? name : `${current.relative}/${name}`;
      const absolute = joinCodePath(current.absolute, name);
      const contained = await resolveContainedPath(input.directory, input.canonicalRoot, absolute);
      if (contained === undefined) continue;
      let path: FileMentionCandidate["path"];
      try {
        path = decodeFileMentionPath(relative);
      } catch {
        continue;
      }
      if (contained.stat.isDirectory) {
        if (input.visited.has(contained.canonical)) continue;
        input.visited.add(contained.canonical);
        input.entries.push({ path, kind: "directory" });
        queue.push({
          absolute: contained.canonical,
          identity: contained.stat,
          relative,
          depth: current.depth + 1,
        });
        continue;
      }
      if (contained.stat.isFile) {
        input.entries.push({ path, kind: "file" });
      }
    }
  }
}
