import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { IMAGE_LIBRARY_SCOPE_ID } from "@octant/contracts";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isPathWithinDirectory } from "./storePath";

/**
 * The files Octant keeps beside its store that belong to the data an import
 * brought over (docs/design/nightly-app.md#importing-from-octant). Only what
 * is named here is ever read; everything else in Octant's folder (identity,
 * listener certificates, hub and remote records, caches, scratch and receipts
 * of other stores, runtimes) belongs to Octant's host and stays behind.
 */

/** Folders holding one folder per thread, named by the thread's id. */
const THREAD_FOLDERS = [
  join("chat", "threads"),
  "work-threads",
  "code-threads",
  "generated-images",
  "generated-video",
  "browser-captures",
] as const;

/** Folders of files named `<aggregate id>.<extension>`. */
const AGGREGATE_FILE_FOLDERS = ["project-icons"] as const;

/** Folders and files the person's own choices and installs live in, copied whole. */
const WHOLE_FOLDERS = [
  "backgrounds",
  "zen-backgrounds",
  join("extensions", "versions"),
  join("extensions", "metadata"),
  join("extensions", "plugin-data"),
  join("extensions", "user-added"),
] as const;
const WHOLE_FILES = [
  join("extensions", "user-added-servers.json"),
  join("extensions", "local-plugin-folders.json"),
  join("secret-stores", "linked-secret-stores.json"),
] as const;

const RECEIPT_FOLDER = "managed-worktree-receipts";
const RECEIPT_FILE =
  /^(?:\.claim-[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A file a writer is still staging; Octant may be running. */
const STAGING_FILE = /\.(?:tmp|partial)$/;
const MAX_RECEIPT_BYTES = 1_000_000;
const CHUNK_BYTES = 1 << 20;
const IMPORT_FOLDER = "import";

interface PlannedFile {
  /** Path under the data folder, the same on both sides unless a receipt says otherwise. */
  readonly path: string;
  readonly source?: string;
  readonly bytes?: Buffer;
}

interface CopyReceipt {
  readonly importId: string;
  readonly files: ReadonlyArray<string>;
  readonly directories: ReadonlyArray<string>;
}

const receiptPath = (dataDirectory: string, importId: string) =>
  join(dataDirectory, IMPORT_FOLDER, `${importId}.json`);

/**
 * Copies the side files of the threads and records that came over, add only:
 * a file Nightly already holds is left as it is, and nothing in Nightly's
 * folder is ever deleted or overwritten. Only regular files are read, never
 * through a link, and never from outside Octant's folder.
 *
 * A receipt naming every file and folder this creates is written first, so
 * `removeCopiedFiles` can take back exactly them when the import never
 * commits. Returns how many files were created.
 */
export function copyOctantSideFiles(input: {
  readonly octantDirectory: string;
  readonly nightlyDirectory: string;
  readonly importId: string;
  readonly threads: ReadonlySet<string>;
  readonly aggregates: ReadonlySet<string>;
  readonly imageArtifacts: ReadonlySet<string>;
}): number {
  const octant = realpathSync(input.octantDirectory);
  const nightly = input.nightlyDirectory;
  const plan = planCopy(octant, nightly, input.threads, input.aggregates, input.imageArtifacts);
  if (plan.length === 0) return 0;

  const directories = new Set<string>();
  for (const entry of plan) {
    for (let folder = dirname(entry.path); folder !== "."; folder = dirname(folder)) {
      if (!exists(join(nightly, folder))) directories.add(folder);
    }
  }
  const created: Array<string> = [];
  const writeReceipt = (files: ReadonlyArray<string>) =>
    writeCopyReceipt(nightly, { importId: input.importId, files, directories: [...directories] });
  writeReceipt(plan.map((entry) => entry.path));
  try {
    for (const entry of plan) {
      const target = join(nightly, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = entry.bytes;
      if (bytes !== undefined) {
        if (!createFile(target, 0o600, (fd) => void writeSync(fd, bytes))) continue;
      } else if (entry.source !== undefined && !copyRegularFile(entry.source, target)) {
        continue;
      }
      created.push(entry.path);
    }
  } finally {
    // What was really created, so a rollback never reaches a file that was not ours.
    writeReceipt(created);
  }
  return created.length;
}

/** Removes exactly the files an import's receipt lists, and the folders it made if now empty. */
export function removeCopiedFiles(dataDirectory: string, importId: string): void {
  const path = receiptPath(dataDirectory, importId);
  const receipt = readCopyReceipt(path, importId);
  if (receipt !== undefined) {
    for (const file of receipt.files) removeRegularFile(dataDirectory, file);
    for (const folder of [...receipt.directories].sort((a, b) => b.length - a.length)) {
      try {
        if (isInside(dataDirectory, folder)) rmdirSync(join(dataDirectory, folder));
      } catch {
        // Not empty or already gone: other data lives there, or nothing is left to take back.
      }
    }
  }
  rmSync(path, { force: true });
}

/** The import's receipt is spent once its store is in place. */
export function discardCopyReceipt(dataDirectory: string, importId: string): void {
  rmSync(receiptPath(dataDirectory, importId), { force: true });
}

/**
 * Takes back the files of imports that never committed: a receipt still on
 * disk whose import the store does not record. One the store does record
 * committed and only lost its receipt, so its files stay.
 */
export function settleInterruptedCopies(input: {
  readonly dataDirectory: string;
  readonly isCommitted: (importId: string) => boolean;
}): void {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(join(input.dataDirectory, IMPORT_FOLDER));
  } catch {
    return;
  }
  for (const name of names) {
    const importId = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
    if (importId === undefined || !SAFE_NAME.test(importId)) continue;
    if (input.isCommitted(importId)) discardCopyReceipt(input.dataDirectory, importId);
    else removeCopiedFiles(input.dataDirectory, importId);
  }
}

function planCopy(
  octant: string,
  nightly: string,
  threads: ReadonlySet<string>,
  aggregates: ReadonlySet<string>,
  imageArtifacts: ReadonlySet<string>,
): ReadonlyArray<PlannedFile> {
  const plan = new Map<string, PlannedFile>();
  const add = (entry: PlannedFile) => {
    if (!plan.has(entry.path) && !exists(join(nightly, entry.path))) plan.set(entry.path, entry);
  };
  const addTree = (folder: string) => {
    for (const path of listRegularFiles(octant, folder)) add({ path, source: join(octant, path) });
  };

  for (const folder of THREAD_FOLDERS) {
    for (const thread of threads) {
      if (SAFE_NAME.test(thread)) addTree(join(folder, thread));
    }
  }
  // The image library is not a thread: its images sit under one shared scope,
  // so they follow the image jobs that came over, by the ids those jobs name.
  for (const image of imageArtifacts) {
    if (SAFE_NAME.test(image)) {
      addTree(join("generated-images", String(IMAGE_LIBRARY_SCOPE_ID), image));
    }
  }
  for (const folder of AGGREGATE_FILE_FOLDERS) {
    for (const path of listRegularFiles(octant, folder)) {
      const id = path.slice(folder.length + 1).split(".")[0] ?? "";
      if (aggregates.has(id)) add({ path, source: join(octant, path) });
    }
  }
  for (const folder of WHOLE_FOLDERS) addTree(folder);
  for (const file of WHOLE_FILES) {
    for (const path of listRegularFiles(octant, file)) add({ path, source: join(octant, path) });
  }

  // A worktree receipt follows its thread, marked as Octant's: the folder it
  // names is Octant's checkout, which this host must never remove. The claim
  // file beside it keeps this host from taking that folder for a new checkout.
  for (const path of listRegularFiles(octant, RECEIPT_FOLDER, 1)) {
    if (!RECEIPT_FILE.test(path.slice(RECEIPT_FOLDER.length + 1))) continue;
    const parsed = readJsonRecord(join(octant, path));
    if (parsed === undefined || typeof parsed.threadId !== "string") continue;
    if (!threads.has(parsed.threadId)) continue;
    add({ path, bytes: Buffer.from(JSON.stringify({ ...parsed, importedFrom: "octant" })) });
  }
  return [...plan.values()];
}

/**
 * Regular files at or under `path` (relative to `root`), never through a link:
 * a link, a device or anything resolving outside `root` is skipped, and
 * so is a file a writer is still staging.
 */
function listRegularFiles(root: string, path: string, depth = 64): ReadonlyArray<string> {
  const absolute = join(root, path);
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    return [];
  }
  if (info.isFile()) return STAGING_FILE.test(path) ? [] : [path];
  if (!info.isDirectory() || depth === 0) return [];
  try {
    if (!isPathWithinDirectory(root, realpathSync(absolute))) return [];
  } catch {
    return [];
  }
  const files: Array<string> = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isFile() || entry.isDirectory()) {
      files.push(...listRegularFiles(root, join(path, entry.name), depth - 1));
    }
  }
  return files;
}

function copyRegularFile(source: string, target: string): boolean {
  // O_NOFOLLOW refuses a link swapped in after the listing.
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(input);
    if (!info.isFile()) return false;
    // Owner bits only: the data folder is owner-only, and a staged package keeps its execute bit.
    const mode = (info.mode & 0o700) | 0o400;
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const created = createFile(target, mode, (output) => {
      for (;;) {
        const read = readSync(input, chunk, 0, CHUNK_BYTES, null);
        if (read === 0) return;
        writeSync(output, chunk, 0, read);
      }
    });
    return created;
  } finally {
    closeSync(input);
  }
}

/** Creates `target` only if absent; false when something already holds the name. */
function createFile(target: string, mode: number, write: (fd: number) => void): boolean {
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    write(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(target, mode);
  return true;
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function writeCopyReceipt(dataDirectory: string, receipt: CopyReceipt): void {
  const path = receiptPath(dataDirectory, receipt.importId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.tmp`;
  writeFileSync(staged, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(staged, path);
}

function readCopyReceipt(path: string, importId: string): CopyReceipt | undefined {
  const parsed = readJsonRecord(path);
  if (parsed === undefined || parsed.importId !== importId) return undefined;
  const strings = (value: unknown): ReadonlyArray<string> =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return { importId, files: strings(parsed.files), directories: strings(parsed.directories) };
}

/** Removes one listed file only if it is still a regular file inside the data folder. */
function removeRegularFile(dataDirectory: string, path: string): void {
  if (!isInside(dataDirectory, path)) return;
  const absolute = join(dataDirectory, path);
  try {
    if (lstatSync(absolute).isFile()) unlinkSync(absolute);
  } catch {
    // Already gone.
  }
}

function isInside(directory: string, path: string): boolean {
  if (isAbsolute(path) || path.length === 0) return false;
  const resolved = relative(directory, join(directory, path));
  return resolved.length > 0 && !resolved.startsWith("..") && !resolved.startsWith(sep);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
