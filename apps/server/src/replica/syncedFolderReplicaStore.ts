/**
 * The in-tree replica store for a folder the person picked.
 *
 * Writes stay under `<folder>/Octant Sync/`. Each publish lands in a temporary
 * file in the same directory, then an atomic publish onto the key. An existing
 * key is not replaced. A file the sync client has not downloaded, and a
 * conflict copy the sync client left behind, are reported instead of being
 * treated as entries. A half-written temporary file is not listed.
 *
 * Authority matches the artifact mirror's global folder: inside the user's
 * home, unless the standing access-outside-project approval exists.
 *
 * A Test connection probe writes one empty file under
 * `<folder>/Octant Sync/.octant-probe/`. An entry key cannot start a segment
 * with `.`, so a probe never collides with an entry, and `list` skips that
 * directory the way the bucket store skips its own probe prefix.
 */

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, link, unlink, writeFile } from "node:fs/promises";
import { constants, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  REPLICA_STORE_CONTRIBUTION_KIND,
  type ReplicaStore,
  type ReplicaStoreGetResult,
  type ReplicaStoreListResult,
  type ReplicaStorePutResult,
  type ReplicaStoreSkipReason,
  type ReplicaStoreStatus,
} from "@octant/plugin-api/replica-store";
import { callOfferedReplicaStore } from "@octant/plugin-host/replica-store";
import { isInsideHomeDirectory } from "../canvas/artifactMirrorFilePort";

const execFile = promisify(execFileCallback);

/** The only directory this store writes. The person picks the parent. */
export const SYNCED_FOLDER_REPLICA_DIRECTORY = "Octant Sync";

/**
 * Synthetic flag from the platform stat word. A set bit means the file is a
 * cloud placeholder that has not been downloaded. Reading it can fetch it, so
 * the store never opens one.
 */
export const DATALESS_FLAG = 0x40000000;

/** Where Test connection probes land, under the sync directory. */
export const SYNCED_FOLDER_PROBE_DIRECTORY = ".octant-probe";

const LIST_PAGE_SIZE = 64;

export interface OpenSyncedFolderReplicaStoreInput {
  readonly folder: string;
  readonly homeDirectory: string;
  readonly outsideHomeApproved: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  /**
   * Platform file flags for one path. Tests pass a stand-in; production reads
   * the dataless bit without opening the file.
   */
  readonly readFileFlags?: (absolutePath: string) => Promise<number>;
  /** Bound for one list page. Production uses the default. */
  readonly pageSize?: number;
}

/**
 * What a Test connection found. `reachable` means one probe file landed;
 * `refused` is authority (outside home, or a symlinked sync directory) and
 * `not-connected` is reach (the folder is missing or not a directory).
 */
export type SyncedFolderConnectionTestResult =
  | { readonly status: "reachable" }
  | { readonly status: "not-connected" }
  | { readonly status: "refused" }
  | { readonly status: "failed"; readonly reason: "write-failed" };

/** The port plus the Test connection probe Settings offers for every store. */
export interface SyncedFolderReplicaStore extends ReplicaStore {
  readonly testConnection: () => Promise<SyncedFolderConnectionTestResult>;
}

export type OpenSyncedFolderReplicaStoreResult =
  | { readonly status: "withheld"; readonly reason: "not-installed" | "disabled" }
  | { readonly status: "offered"; readonly store: SyncedFolderReplicaStore };

type ReadyRoot = {
  readonly status: "ready";
  readonly folder: string;
  readonly syncRoot: string;
};

type RootResolution =
  | ReadyRoot
  | { readonly status: "not-connected" }
  | { readonly status: "refused" };

/**
 * Open the folder store, or withhold it.
 *
 * A disabled or uninstalled store is not constructed and not called. The
 * folder is not inspected on that path.
 */
export function openSyncedFolderReplicaStore(
  input: OpenSyncedFolderReplicaStoreInput,
): OpenSyncedFolderReplicaStoreResult {
  const opened = callOfferedReplicaStore(
    { installed: input.installed, enabled: input.enabled },
    () => createSyncedFolderReplicaStore(input),
  );
  if ("reason" in opened) return opened;
  return { status: "offered", store: opened };
}

export function createSyncedFolderReplicaStore(
  input: OpenSyncedFolderReplicaStoreInput,
): SyncedFolderReplicaStore {
  const readFileFlags = input.readFileFlags ?? readPlatformFileFlags;
  const pageSize = input.pageSize ?? LIST_PAGE_SIZE;

  async function resolveRoot(): Promise<RootResolution> {
    if (!isAbsolute(input.folder)) return { status: "refused" };
    const lexical = resolve(input.folder);
    if (!folderAllowed(lexical, input.homeDirectory, input.outsideHomeApproved)) {
      return { status: "refused" };
    }
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch {
      return { status: "not-connected" };
    }
    if (!folderAllowed(canonical, input.homeDirectory, input.outsideHomeApproved)) {
      return { status: "refused" };
    }
    try {
      const metadata = await lstat(canonical);
      if (!metadata.isDirectory()) return { status: "not-connected" };
    } catch {
      return { status: "not-connected" };
    }
    return {
      status: "ready",
      folder: canonical,
      syncRoot: join(canonical, SYNCED_FOLDER_REPLICA_DIRECTORY),
    };
  }

  return {
    kind: REPLICA_STORE_CONTRIBUTION_KIND,
    async status(): Promise<ReplicaStoreStatus> {
      const root = await resolveRoot();
      if (root.status === "refused") return "refused";
      if (root.status === "not-connected") return "not-connected";
      return "ready";
    },

    async list(afterCursor?: string): Promise<ReplicaStoreListResult> {
      const root = await resolveRoot();
      if (root.status === "refused") return { status: "refused", reason: "outside-home" };
      if (root.status === "not-connected") return { status: "not-connected" };
      try {
        return await listSyncRoot(root.syncRoot, afterCursor, pageSize, readFileFlags);
      } catch {
        return { status: "not-connected" };
      }
    },

    async get(key: string): Promise<ReplicaStoreGetResult> {
      const root = await resolveRoot();
      if (root.status === "refused") return { status: "refused", reason: "outside-home" };
      if (root.status === "not-connected") return { status: "not-connected" };
      const destination = resolveReplicaKey(root.syncRoot, key);
      if (destination === undefined) return { status: "refused", reason: "key-refused" };
      const named = skipReason(key, 0);
      if (named !== undefined) return { status: "refused", reason: named };
      try {
        const canonicalParent = await realpath(dirname(destination));
        if (!isContained(root.syncRoot, canonicalParent)) {
          return { status: "refused", reason: "key-refused" };
        }
      } catch (error) {
        if (isEnoent(error)) return { status: "missing" };
        return { status: "refused", reason: "key-refused" };
      }
      try {
        return await readConfinedFile(destination, readFileFlags);
      } catch (error) {
        if (isEnoent(error)) return { status: "missing" };
        return { status: "refused", reason: "key-refused" };
      }
    },

    async putIfAbsent(key: string, bytes: Uint8Array): Promise<ReplicaStorePutResult> {
      const snapshot = new Uint8Array(bytes);
      const root = await resolveRoot();
      if (root.status === "refused") return { status: "refused", reason: "outside-home" };
      if (root.status === "not-connected") return { status: "not-connected" };
      const destination = resolveReplicaKey(root.syncRoot, key);
      if (destination === undefined || skipReason(key, 0) !== undefined) {
        return { status: "refused", reason: "key-refused" };
      }
      const confined = await ensureConfinedDirectory(root.folder, root.syncRoot, destination);
      if (!confined) return { status: "refused", reason: "key-refused" };
      const gate = await publishGate(root.syncRoot, destination);
      if (gate === "escaped") return { status: "refused", reason: "key-refused" };
      if (gate === "occupied") return { status: "already-exists" };
      return publishIfAbsent(destination, snapshot);
    },

    async testConnection(): Promise<SyncedFolderConnectionTestResult> {
      const root = await resolveRoot();
      if (root.status !== "ready") return { status: root.status };
      // The probe takes the same confined, write-once path an entry does, so
      // a reachable answer means an entry could be published here too. It is
      // never deleted: `list` skips the probe directory.
      const destination = join(root.syncRoot, SYNCED_FOLDER_PROBE_DIRECTORY, randomUUID());
      const confined = await ensureConfinedDirectory(root.folder, root.syncRoot, destination);
      if (!confined) return { status: "refused" };
      const gate = await publishGate(root.syncRoot, destination);
      if (gate === "escaped") return { status: "refused" };
      if (gate === "occupied") return { status: "reachable" };
      const published = await publishIfAbsent(destination, new Uint8Array());
      if (published.status === "stored" || published.status === "already-exists") {
        return { status: "reachable" };
      }
      return { status: "failed", reason: "write-failed" };
    },
  };
}

/**
 * Read the platform file-flag word without opening the file.
 *
 * On macOS the dataless bit is in that word. Opening the file can download
 * it, which is the opposite of ignoring a placeholder. Other platforms have
 * no equivalent bit; name-based stubs are still recognized.
 */
export async function readPlatformFileFlags(absolutePath: string): Promise<number> {
  if (process.platform !== "darwin") return 0;
  try {
    const { stdout } = await execFile("/usr/bin/stat", ["-f", "%f", absolutePath], {
      timeout: 2_000,
      encoding: "utf8",
    });
    const flags = Number.parseInt(stdout.trim(), 10);
    // A flag word we cannot read is treated as not downloaded. Opening the
    // file to find out would fetch a placeholder.
    return Number.isFinite(flags) ? flags : DATALESS_FLAG;
  } catch {
    return DATALESS_FLAG;
  }
}

export function isSyncedFolderWriteTempName(name: string): boolean {
  return name.startsWith(".") && name.includes(".octant-write-") && name.endsWith(".tmp");
}

function folderAllowed(
  folder: string,
  homeDirectory: string,
  outsideHomeApproved: boolean,
): boolean {
  return isInsideHomeDirectory(folder, homeDirectory) || outsideHomeApproved;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

/**
 * A key is a relative path under the sync directory. Anything that could
 * leave that directory, or that is one of our own temporary names, is refused
 * before a write.
 */
function resolveReplicaKey(syncRoot: string, key: string): string | undefined {
  if (key.length === 0 || key.length > 512 || key.includes("\0") || key.includes("\\")) {
    return undefined;
  }
  if (key.startsWith("/") || key.startsWith(".")) return undefined;
  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    return undefined;
  }
  const destination = resolve(syncRoot, key);
  if (!isContained(syncRoot, destination) || destination === resolve(syncRoot)) return undefined;
  return destination;
}

function skipReason(key: string, flags: number): ReplicaStoreSkipReason | undefined {
  const name = key.slice(key.lastIndexOf("/") + 1);
  if (isConflictCopyName(name)) return "conflict-copy";
  if (isPlaceholderName(name) || isDataless(flags)) return "not-downloaded";
  return undefined;
}

function isConflictCopyName(name: string): boolean {
  return / \(conflicted copy\b/i.test(name) || name.includes(".sync-conflict-");
}

function isPlaceholderName(name: string): boolean {
  return name.endsWith(".icloud");
}

function isDataless(flags: number): boolean {
  return (flags & DATALESS_FLAG) !== 0;
}

async function flagsOf(
  absolutePath: string,
  readFileFlags: (absolutePath: string) => Promise<number>,
): Promise<number> {
  try {
    return await readFileFlags(absolutePath);
  } catch {
    return DATALESS_FLAG;
  }
}

/**
 * Read the key through a descriptor that cannot be moved by a symlink swap.
 *
 * A path-based read re-resolves the name: a sync client that replaces the
 * file with a symlink while this call awaits would point the bytes outside
 * the sync folder. `O_NOFOLLOW` refuses the final symlink (ELOOP), and the
 * regular-file assertion plus the read run against the opened descriptor, so
 * the checked inode is the read inode.
 */
async function readConfinedFile(
  destination: string,
  readFileFlags: (absolutePath: string) => Promise<number>,
): Promise<ReplicaStoreGetResult> {
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { status: "missing" };
    if (isDataless(await flagsOf(destination, readFileFlags))) {
      return { status: "refused", reason: "not-downloaded" };
    }
    const bytes = await handle.readFile();
    return { status: "ready", bytes: new Uint8Array(bytes) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function listSyncRoot(
  syncRoot: string,
  afterCursor: string | undefined,
  pageSize: number,
  readFileFlags: (absolutePath: string) => Promise<number>,
): Promise<ReplicaStoreListResult> {
  const files = await walkFiles(syncRoot);
  let index = 0;
  if (afterCursor !== undefined) {
    const next = files.findIndex((file) => file > afterCursor);
    index = next < 0 ? files.length : next;
  }
  const entries: { key: string }[] = [];
  const reports: { key: string; reason: ReplicaStoreSkipReason }[] = [];
  let lastExamined: string | undefined;
  let examined = 0;
  for (let cursor = index; cursor < files.length; cursor += 1) {
    const key = files[cursor];
    if (key === undefined) break;
    lastExamined = key;
    examined += 1;
    const name = key.slice(key.lastIndexOf("/") + 1);
    if (isSyncedFolderWriteTempName(name) || key.startsWith(`${SYNCED_FOLDER_PROBE_DIRECTORY}/`)) {
      if (examined >= pageSize) break;
      continue;
    }
    const conflictOrPlaceholder = skipReason(key, 0);
    if (conflictOrPlaceholder === "conflict-copy" || isPlaceholderName(name)) {
      reports.push({ key, reason: conflictOrPlaceholder ?? "not-downloaded" });
      if (examined >= pageSize) break;
      continue;
    }
    const absolute = resolve(syncRoot, key);
    if (!isContained(syncRoot, absolute)) {
      if (examined >= pageSize) break;
      continue;
    }
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch {
      if (examined >= pageSize) break;
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      if (examined >= pageSize) break;
      continue;
    }
    const flags = await flagsOf(absolute, readFileFlags);
    if (isDataless(flags)) {
      reports.push({ key, reason: "not-downloaded" });
      if (examined >= pageSize) break;
      continue;
    }
    entries.push({ key });
    if (examined >= pageSize || entries.length >= pageSize) break;
  }
  const more = index + examined < files.length;
  return {
    status: "ready",
    entries,
    reports,
    ...(more && lastExamined !== undefined ? { nextCursor: lastExamined } : {}),
  };
}

async function walkFiles(syncRoot: string): Promise<readonly string[]> {
  let listed: Dirent[];
  try {
    listed = await readdir(syncRoot, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of listed) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath;
    const absolute =
      parent !== undefined && parent.length > 0
        ? join(parent, entry.name)
        : join(syncRoot, entry.name);
    if (!isContained(syncRoot, absolute)) continue;
    files.push(relative(syncRoot, absolute).split(sep).join("/"));
  }
  files.sort();
  return files;
}

/**
 * Create the sync directory and the key's parent one name at a time.
 *
 * Recursive mkdir follows an intermediate symlink and can create directories
 * outside the folder before the containment check runs. Each missing name is
 * created only after its parent still sits inside the folder, and every
 * component on the way must be a real directory: a symlink that stays inside
 * the folder still rewrites where the key's bytes truly land, so a write
 * refuses it as well as one that escapes.
 */
async function ensureConfinedDirectory(
  folder: string,
  syncRoot: string,
  destination: string,
): Promise<boolean> {
  if (!(await mkdirEachContained(folder, syncRoot))) return false;
  let canonicalSync: string;
  try {
    canonicalSync = await realpath(syncRoot);
  } catch {
    return false;
  }
  if (!isContained(folder, canonicalSync)) return false;
  return mkdirEachContained(canonicalSync, dirname(destination));
}

async function mkdirEachContained(root: string, target: string): Promise<boolean> {
  const missing: string[] = [];
  let cursor = target;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) return false;
      break;
    } catch (error) {
      if (!isEnoent(error)) return false;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
  let canonical: string;
  try {
    canonical = await realpath(cursor);
  } catch {
    return false;
  }
  if (!isContained(root, canonical)) return false;
  for (const next of missing.reverse()) {
    try {
      await mkdir(next);
    } catch {
      return false;
    }
    let created: string;
    try {
      created = await realpath(next);
    } catch {
      return false;
    }
    if (!isContained(root, created)) return false;
  }
  return true;
}

/**
 * The last look before a publish lands bytes on the key.
 *
 * A sync client can replace a verified directory with a symlink while the
 * publish awaits, and `link` then follows it: the exists check would
 * misreport the situation as already-exists and the bytes would land in the
 * symlink target. A symlink at the key name is always a refusal, never an
 * occupied key. The gate re-canonicalizes the real parent against the sync
 * root right before the exclusive link, so a parent swapped for a symlink
 * after the confined-directory walk still refuses.
 */
async function publishGate(
  syncRoot: string,
  destination: string,
): Promise<"open" | "occupied" | "escaped"> {
  let metadata;
  try {
    metadata = await lstat(destination);
  } catch (error) {
    if (!isEnoent(error)) return "escaped";
  }
  if (metadata !== undefined) {
    if (metadata.isSymbolicLink()) return "escaped";
    if (!metadata.isFile() && !metadata.isDirectory()) return "escaped";
    return "occupied";
  }
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(dirname(destination));
  } catch {
    return "escaped";
  }
  if (!isContained(syncRoot, canonicalParent)) return "escaped";
  return "open";
}

/**
 * Write the complete bytes beside the key, then link them onto it.
 *
 * The temporary file is in the same directory. `link` fails if the key
 * already exists, so two publishers cannot replace each other. A reader
 * never sees a partial file under the key.
 */
async function publishIfAbsent(
  destination: string,
  bytes: Uint8Array,
): Promise<ReplicaStorePutResult> {
  const name = destination.split(sep).pop() ?? "entry";
  const temp = join(dirname(destination), `.${name}.octant-write-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: "wx" });
  } catch {
    await unlink(temp).catch(() => undefined);
    return { status: "refused", reason: "write-failed" };
  }
  try {
    await link(temp, destination);
    return { status: "stored" };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return { status: "already-exists" };
    return { status: "refused", reason: "write-failed" };
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
