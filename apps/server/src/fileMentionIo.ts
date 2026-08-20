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
export interface FileMentionIo {
  locate(rootPath: string, relativePath: string): Promise<FileMentionLocation>;
  readBytes(
    canonicalPath: string,
    expected: { readonly device: string; readonly inode: string },
    maximumBytes: number,
  ): Promise<Uint8Array | undefined>;
  list(rootPath: string): Promise<ReadonlyArray<FileMentionCandidate>>;
}

export function createFileMentionIo(
  directory: CodeDirectoryPort = liveCodeDirectoryPort,
  files: CodeTestSourcePort = liveCodeTestSourcePort,
): FileMentionIo {
  return {
    async locate(rootPath, relativePath) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await directory.realpath(rootPath);
      } catch {
        return { kind: "missing" };
      }
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
        if (opened.size > maximumBytes) return undefined;
        const bytes = await file.read(opened.size + 1);
        if (bytes.byteLength !== opened.size) return undefined;
        return bytes;
      } catch {
        return undefined;
      } finally {
        await file.close().catch(() => undefined);
      }
    },
    async list(rootPath) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await directory.realpath(rootPath);
      } catch {
        return [];
      }
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
  if (input.depth > MAX_LISTING_DEPTH) return;
  if (input.entries.length >= MAX_LISTING_ENTRIES) return;
  const names = await readContainedDirectoryNames(
    input.directory,
    input.absolute,
    input.identity,
    MAX_LISTING_ENTRIES - input.entries.length + 1,
  );
  if (names === undefined) return;
  for (const name of names) {
    if (input.entries.length >= MAX_LISTING_ENTRIES) return;
    if (name === "." || name === ".." || SKIPPED_DIRECTORIES.has(name)) continue;
    const relative = input.relative === "" ? name : `${input.relative}/${name}`;
    const absolute = joinCodePath(input.absolute, name);
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
      await walk({
        ...input,
        absolute: contained.canonical,
        identity: contained.stat,
        relative,
        depth: input.depth + 1,
      });
      continue;
    }
    if (contained.stat.isFile) {
      input.entries.push({ path, kind: "file" });
    }
  }
}
