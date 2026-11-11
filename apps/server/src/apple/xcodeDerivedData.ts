import { execFile } from "node:child_process";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { measureFolder, type FolderSize } from "../code/archivedWorktrees";

const execFileAsync = promisify(execFile);

/** Xcode builds that have not been opened for this long are offered for removal. */
export const UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const SIZE_ENTRIES = 200_000;

export type DerivedDataState = "orphaned" | "unused" | "volume-offline" | "in-use";

export interface DerivedDataEntry {
  /** The folder's name under DerivedData, `<Project>-<hash>`. */
  readonly name: string;
  readonly workspacePath: string | undefined;
  readonly lastAccessedMs: number | undefined;
  readonly state: DerivedDataState;
  readonly size: FolderSize | undefined;
}

export interface XcodeDerivedDataDependencies {
  /** `~/Library/Developer/Xcode/DerivedData` on a Mac; absent elsewhere. */
  readonly root: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
}

/**
 * The build folders Xcode keeps per workspace in its shared DerivedData
 * folder. Each records the workspace it belongs to and when Xcode last opened
 * it. One whose workspace is gone, as when an agent's worktree was deleted, is
 * orphaned and nothing will use it again; one not opened for 30 days is
 * unused. A workspace on a volume that is not mounted is neither: it may come
 * back. These folders are caches Xcode rebuilds, and none is Octant's.
 */
export function createXcodeDerivedData(dependencies: XcodeDerivedDataDependencies) {
  async function read(name: string): Promise<DerivedDataEntry | undefined> {
    const root = dependencies.root;
    if (root === undefined || !plainName(name)) return undefined;
    const folder = join(root, name);
    const status = await lstat(folder).catch(() => undefined);
    if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) return undefined;
    const info = await readInfo(join(folder, "info.plist"), dependencies.platform);
    if (info === undefined) return undefined;
    const lastAccessedMs = info.lastAccessedMs ?? status.mtimeMs;
    const state = await stateOf(info.workspacePath, lastAccessedMs, dependencies.now());
    return {
      name,
      workspacePath: info.workspacePath,
      lastAccessedMs,
      state,
      size: undefined,
    };
  }

  return {
    available: dependencies.root !== undefined,

    /** The folders Xcode would not miss: orphaned and unused, largest first. */
    async list(): Promise<ReadonlyArray<DerivedDataEntry>> {
      const root = dependencies.root;
      if (root === undefined) return [];
      let names: ReadonlyArray<string>;
      try {
        names = await readdir(root);
      } catch {
        return [];
      }
      const listed: DerivedDataEntry[] = [];
      for (const name of names) {
        const entry = await read(name);
        if (entry === undefined || (entry.state !== "orphaned" && entry.state !== "unused"))
          continue;
        listed.push({ ...entry, size: await measureFolder(join(root, name), SIZE_ENTRIES) });
      }
      return listed.sort((a, b) => (b.size?.bytes ?? 0) - (a.size?.bytes ?? 0));
    },

    /**
     * Removes one build folder, after reading it again: a folder Xcode opened
     * since it was listed, or whose workspace came back, is refused.
     */
    async remove(
      name: string,
    ): Promise<
      | Readonly<{ status: "removed" }>
      | Readonly<{ status: "refused"; reason: "not-found" | "in-use" }>
    > {
      const root = dependencies.root;
      const entry = await read(name);
      if (root === undefined || entry === undefined)
        return { status: "refused", reason: "not-found" };
      if (entry.state !== "orphaned" && entry.state !== "unused") {
        return { status: "refused", reason: "in-use" };
      }
      await rm(join(root, name), { recursive: true, force: true });
      return { status: "removed" };
    },
  };
}

export type XcodeDerivedData = ReturnType<typeof createXcodeDerivedData>;

async function stateOf(
  workspacePath: string | undefined,
  lastAccessedMs: number,
  now: number,
): Promise<DerivedDataState> {
  if (workspacePath !== undefined) {
    const present = await lstat(workspacePath).then(
      () => true,
      () => false,
    );
    if (!present) {
      const volume = /^\/Volumes\/[^/]+/.exec(workspacePath)?.[0];
      if (volume !== undefined && !(await exists(volume))) return "volume-offline";
      return "orphaned";
    }
  }
  return now - lastAccessedMs > UNUSED_AFTER_MS ? "unused" : "in-use";
}

interface DerivedDataInfo {
  readonly workspacePath: string | undefined;
  readonly lastAccessedMs: number | undefined;
}

/**
 * Reads `info.plist`. Xcode writes it as XML; a binary one is converted with
 * the system's `plutil`, which only a Mac has.
 */
async function readInfo(
  path: string,
  platform: NodeJS.Platform,
): Promise<DerivedDataInfo | undefined> {
  let text: string;
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.size > 1024 * 1024) return undefined;
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  if (text.startsWith("bplist")) {
    if (platform !== "darwin") return undefined;
    try {
      text = (
        await execFileAsync("plutil", ["-convert", "xml1", "-o", "-", path], { timeout: 5_000 })
      ).stdout;
    } catch {
      return undefined;
    }
  }
  return parseInfoPlist(text);
}

export function parseInfoPlist(xml: string): DerivedDataInfo {
  const workspace = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
  const accessed = /<key>LastAccessedDate<\/key>\s*<date>([^<]*)<\/date>/.exec(xml)?.[1];
  const accessedMs = accessed === undefined ? Number.NaN : Date.parse(accessed);
  return {
    workspacePath: workspace === undefined ? undefined : unescapeXml(workspace),
    lastAccessedMs: Number.isFinite(accessedMs) ? accessedMs : undefined,
  };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function plainName(name: string): boolean {
  return (
    name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes(sep)
  );
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
