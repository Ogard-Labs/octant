// The files of a Work thread's own folder, carried with its move. Work
// threads in a Project share its folder, and a turn writes files through its
// shell and the provider's own tools as well as through Octant, so which
// files one thread made cannot be told reliably. A move therefore carries a
// folder only when the thread is its sole user: the subfolder the thread was
// started in, which no other thread works in or below and which holds no
// Project's folder. The Project folder itself, an extra folder (shared by
// definition), and a shared subfolder stay where they are.
//
// What travels is read the way a Code worktree is: ignored files, the `.git`
// folder, symbolic links, anything that is not a plain file or folder, and a
// file the Secret guard refuses stay behind. The source walks the folder
// without following a link, so nothing outside it is read.
//
// The destination lands the files where the thread works there: the same
// subfolder of the destination Project's main folder, or, when that path is
// taken, a fresh one beside it. It never writes into a folder that holds
// anything else, so no file of the person's is overwritten, and a retried
// arrival finds its own earlier landing and lands nothing twice.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  ThreadWorkingDirectory,
  type ApprovedWorkingFolder,
  type BoundProject,
  type Project,
  type WorkThread,
} from "@octant/contracts";
import { approvedWorkingFolderChoices, approvedWorkingFolderRoot } from "../approvedWorkingFolders";
import { redactSecrets } from "@octant/domain";
import { Option, Schema } from "effect";
import { SECRET_SCAN_LIMIT_BYTES } from "./codeThreadMoveGit";

/**
 * How many files and empty folders one move carries from a Work folder, the
 * bound the moved transcript holds its entries to. Past it the rest stay
 * behind and are named, and the folder is kept.
 */
export const MOVED_WORK_FOLDER_ENTRIES_MAX = 10_000;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** A path inside the folder, held to the rules a thread's working directory follows. */
const MovedWorkPath = ThreadWorkingDirectory.pipe(
  Schema.filter((path) => path !== "." || "A moved path names something inside the folder."),
);
const isMovedWorkPath = Schema.is(MovedWorkPath);

/** Permission bits only (`mode & 0o777`): setuid, setgid, and sticky bits never travel. */
const PermissionBits = Schema.Int.pipe(Schema.between(0, 0o777));

/** What the moved transcript says about the folder's files. */
export const MovedWorkFolder = Schema.Struct({
  /** Where the thread worked, under its Project's main folder. */
  workingDirectory: MovedWorkPath,
  /** The part that holds every file, back to back in list order; absent when none travels. */
  partId: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
  files: Schema.Array(
    Schema.Struct({
      path: MovedWorkPath,
      bytes: Schema.Int.pipe(Schema.nonNegative()),
      sha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
      /**
       * The file's permission bits (`mode & 0o777`), so a script stays
       * runnable and a private file stays private. Setuid, setgid, and
       * sticky bits never travel.
       */
      mode: PermissionBits,
    }).annotations(strict),
  ).pipe(Schema.maxItems(MOVED_WORK_FOLDER_ENTRIES_MAX)),
  emptyFolders: Schema.Array(MovedWorkPath).pipe(Schema.maxItems(MOVED_WORK_FOLDER_ENTRIES_MAX)),
  /**
   * The folder's own permission bits and those of every folder inside it
   * that travels, so a private folder stays private where it lands.
   */
  rootMode: PermissionBits,
  folderModes: Schema.Array(
    Schema.Struct({ path: MovedWorkPath, mode: PermissionBits }).annotations(strict),
  ).pipe(Schema.maxItems(MOVED_WORK_FOLDER_ENTRIES_MAX)),
})
  .pipe(
    Schema.filter((folder) =>
      folder.files.length + folder.emptyFolders.length <= MOVED_WORK_FOLDER_ENTRIES_MAX
        ? true
        : "A move carries at most 10,000 files and empty folders from a Work folder.",
    ),
    Schema.filter((folder) => {
      const paths = [...folder.files.map((file) => file.path), ...folder.emptyFolders];
      return new Set(paths).size === paths.length ? true : "A moved path must not repeat.";
    }),
    Schema.filter((folder) =>
      (folder.partId !== undefined) === folder.files.length > 0
        ? true
        : "The files part is named exactly when a file travels.",
    ),
  )
  .annotations(strict);
export type MovedWorkFolder = typeof MovedWorkFolder.Type;

/** Whose folder a Work thread works in, as a move judges it. */
export type WorkThreadFolder =
  | {
      readonly status: "own";
      /** The folder on this computer. */
      readonly folder: string;
      readonly workingDirectory: ThreadWorkingDirectory;
    }
  | {
      readonly status: "stays";
      readonly reason: "project-folder" | "extra-folder" | "shared" | "unavailable";
    };

/**
 * Whether a Work thread is the only user of the folder it works in. Every
 * path is absolute; the caller resolves each from the host's own Project
 * records, and each is compared by the real folder `realFolder` names, so a
 * thread working through a link to this folder shares it.
 */
export function workThreadOwnFolder(input: {
  readonly workingFolder:
    | { readonly kind: "main"; readonly root: string }
    | { readonly kind: "extra" }
    | { readonly kind: "unavailable" };
  readonly workingDirectory: ThreadWorkingDirectory | undefined;
  /**
   * Whether the thread still belongs to its Project's current binding. A
   * Project relinked since names another folder, which the thread never
   * worked in, so nothing there is its own.
   */
  readonly bindingCurrent: boolean;
  /** The real folder a path names, links resolved; the path as written when it can't be read. */
  readonly realFolder: (path: string) => string;
  /** Where every other Work thread on this host that is not deleted works. */
  readonly otherThreadFolders: ReadonlyArray<string>;
  /** Every folder every Project on this host is bound to, main and extra. */
  readonly projectFolders: ReadonlyArray<string>;
}): WorkThreadFolder {
  const { workingFolder, workingDirectory } = input;
  if (workingFolder.kind === "unavailable" || !input.bindingCurrent) {
    return { status: "stays", reason: "unavailable" };
  }
  if (workingFolder.kind === "extra") return { status: "stays", reason: "extra-folder" };
  if (workingDirectory === undefined || workingDirectory === ".") {
    return { status: "stays", reason: "project-folder" };
  }
  const folder = join(workingFolder.root, workingDirectory);
  const realFolder = input.realFolder(folder);
  const isInside = (other: string) => {
    const path = relative(realFolder, input.realFolder(other));
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  // A thread working above the folder is not counted: the subfolder was the
  // one this thread was started in. One working in it or below shares it,
  // and a Project bound inside it makes it that Project's folder too.
  if (input.otherThreadFolders.some(isInside) || input.projectFolders.some(isInside)) {
    return { status: "stays", reason: "shared" };
  }
  return { status: "own", folder, workingDirectory };
}

/** The real folder a path names, links resolved; the path as written when it can't be read. */
export function realFolderOrAsWritten(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * {@link workThreadOwnFolder} read from the host's own records: the thread,
 * every other Work thread that is not deleted, and every Project's folders.
 */
export function workThreadFolderOf(input: {
  readonly thread: WorkThread;
  readonly threads: ReadonlyArray<WorkThread>;
  readonly projects: ReadonlyArray<Project>;
}): WorkThreadFolder {
  const boundProject = (projectId: string): BoundProject | undefined => {
    const project = input.projects.find((candidate) => String(candidate.id) === projectId);
    return project === undefined || project.type === "chat" ? undefined : project;
  };
  const threadFolder = (thread: WorkThread): string | undefined => {
    const project = boundProject(String(thread.projectId));
    if (project?.type !== "work") return undefined;
    try {
      const root = approvedWorkingFolderRoot(project, thread.workingFolderId);
      return root === undefined ? undefined : join(root, thread.workingDirectory ?? ".");
    } catch {
      return undefined;
    }
  };
  const project = boundProject(String(input.thread.projectId));
  let workingFolder: Parameters<typeof workThreadOwnFolder>[0]["workingFolder"];
  if (project?.type !== "work") {
    workingFolder = { kind: "unavailable" };
  } else if (input.thread.workingFolderId === undefined) {
    workingFolder = { kind: "main", root: project.binding.canonicalRoot };
  } else {
    let choice: ApprovedWorkingFolder | undefined;
    try {
      choice = approvedWorkingFolderChoices(project).find(
        (folder) => String(folder.id) === String(input.thread.workingFolderId),
      );
    } catch {
      choice = undefined;
    }
    workingFolder =
      choice === undefined
        ? { kind: "unavailable" }
        : choice.kind === "main"
          ? { kind: "main", root: project.binding.canonicalRoot }
          : { kind: "extra" };
  }
  const currentBinding = project?.type === "work" ? project.bindingHistory.at(-1) : undefined;
  return workThreadOwnFolder({
    workingFolder,
    workingDirectory: input.thread.workingDirectory,
    // A thread from before bindings were recorded on it is judged by the current one.
    bindingCurrent:
      input.thread.bindingRevisionId === undefined ||
      String(input.thread.bindingRevisionId) === String(currentBinding?.revisionId),
    realFolder: realFolderOrAsWritten,
    otherThreadFolders: input.threads
      .filter(
        (other) => String(other.id) !== String(input.thread.id) && other.lifecycle !== "deleted",
      )
      .flatMap((other) => {
        const folder = threadFolder(other);
        return folder === undefined ? [] : [folder];
      }),
    projectFolders: input.projects.flatMap((candidate) =>
      candidate.type === "chat"
        ? []
        : [
            candidate.binding.canonicalRoot,
            ...(candidate.extraFolders ?? []).map((folder) => folder.canonicalRoot),
          ],
    ),
  });
}

/** A file as the walk found it, with the identity a later read must still see. */
interface WalkedFile {
  readonly path: string;
  readonly bytes: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

interface WalkedFolder {
  readonly files: ReadonlyArray<WalkedFile>;
  readonly emptyFolders: ReadonlyArray<string>;
  /** The folder's own permission bits. */
  readonly rootMode: number;
  /** The permission bits of every folder inside it the walk entered. */
  readonly folderModes: ReadonlyMap<string, number>;
  /** Entries that never travel: ignored, `.git`, links, special files, unnamable paths, past the bound. */
  readonly left: ReadonlyArray<string>;
}

/**
 * Lists what a move of the folder would carry and what stays, following no
 * link. The folder itself must be a real folder at exactly that path, or the
 * walk throws: a link anywhere in it would put the files elsewhere.
 */
async function walkWorkFolder(
  folder: string,
  /** Called before each folder inside is listed; tests use it to swap the folder for a link. */
  beforeListing?: (path: string) => Promise<void>,
): Promise<WalkedFolder> {
  const top = await lstat(folder);
  if (!top.isDirectory() || (await realpath(folder)) !== folder) {
    throw new Error("The Work folder is not a plain folder at its own path.");
  }
  const files: WalkedFile[] = [];
  const emptyFolders: string[] = [];
  const folderModes = new Map<string, number>();
  const left: string[] = [];
  const ignoring = await insideGitWorkTree(folder);
  // Breadth first, one ignore check per depth, so an ignored folder (build
  // output, installed dependencies) is named once and never walked.
  let level: ReadonlyArray<string> = [""];
  while (level.length > 0) {
    const entries: Array<{ path: string; kind: "file" | "folder" | "other" }> = [];
    for (const parent of level) {
      if (parent !== "") await beforeListing?.(parent);
      // A folder swapped for a link after its check would list what the link
      // points at, outside the folder; one that is no longer itself is left,
      // checked both before and after it is listed.
      if (parent !== "" && !(await folderIsItself(join(folder, parent)))) {
        left.push(parent);
        continue;
      }
      const children = await readdir(join(folder, parent), { withFileTypes: true });
      if (parent !== "" && !(await folderIsItself(join(folder, parent)))) {
        left.push(parent);
        continue;
      }
      if (children.length === 0 && parent !== "") {
        if (isMovedWorkPath(parent)) emptyFolders.push(parent);
        else left.push(parent);
      }
      for (const child of children) {
        const path = parent === "" ? child.name : `${parent}/${child.name}`;
        const kind = child.isSymbolicLink()
          ? "other"
          : child.isDirectory()
            ? "folder"
            : child.isFile()
              ? "file"
              : "other";
        entries.push({ path, kind });
      }
    }
    const ignored = ignoring
      ? await ignoredPaths(
          folder,
          entries.map((entry) => (entry.kind === "folder" ? `${entry.path}/` : entry.path)),
        )
      : new Set<string>();
    const next: string[] = [];
    for (const entry of entries) {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const stays =
        entry.kind === "other" ||
        name === ".git" ||
        ignored.has(entry.path) ||
        !isMovedWorkPath(entry.path);
      if (stays) left.push(entry.path);
      else if (entry.kind === "folder") {
        const found = await lstat(join(folder, entry.path)).catch(() => undefined);
        if (found?.isDirectory() === true) {
          folderModes.set(entry.path, found.mode & 0o777);
          next.push(entry.path);
        }
      } else {
        // A file deleted since the folder was listed has nothing to carry or keep.
        const found = await lstat(join(folder, entry.path)).catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
        if (found?.isFile() === true) {
          files.push({
            path: entry.path,
            bytes: found.size,
            mode: found.mode & 0o777,
            dev: found.dev,
            ino: found.ino,
          });
        }
      }
    }
    level = next;
  }
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort((a, b) => byPath(a.path, b.path));
  emptyFolders.sort(byPath);
  // Each carried entry also carries the bits of every folder it sits in, and
  // a deep tree can name more folders than entries, so an entry travels only
  // while both its own count and the folders it adds stay within the bound.
  const carriedFolders = new Set<string>();
  const fits = (path: string, isFolder: boolean, carriedEntries: number): boolean => {
    if (carriedEntries >= MOVED_WORK_FOLDER_ENTRIES_MAX) return false;
    const parts = path.split("/");
    const adds = parts
      .slice(0, isFolder ? parts.length : parts.length - 1)
      .map((_, depth) => parts.slice(0, depth + 1).join("/"))
      .filter((folderPath) => !carriedFolders.has(folderPath));
    if (carriedFolders.size + adds.length > MOVED_WORK_FOLDER_ENTRIES_MAX) return false;
    for (const folderPath of adds) carriedFolders.add(folderPath);
    return true;
  };
  const keptFiles: WalkedFile[] = [];
  const keptFolders: string[] = [];
  const pastTheBound: string[] = [];
  for (const file of files) {
    if (fits(file.path, false, keptFiles.length)) keptFiles.push(file);
    else pastTheBound.push(file.path);
  }
  for (const path of emptyFolders) {
    if (fits(path, true, keptFiles.length + keptFolders.length)) keptFolders.push(path);
    else pastTheBound.push(path);
  }
  return {
    files: keptFiles,
    emptyFolders: keptFolders,
    rootMode: top.mode & 0o777,
    folderModes,
    left: [...left, ...pastTheBound].sort(byPath),
  };
}

/**
 * About how many bytes a move of the folder would carry, read without
 * writing anything: every file that is not ignored or a link, at its size on
 * disk. A file the Secret guard would refuse is still counted, since telling
 * would mean reading every file now.
 */
export async function measureWorkFolderForMove(folder: string): Promise<number> {
  const walked = await walkWorkFolder(folder);
  return walked.files.reduce((total, file) => total + file.bytes, 0);
}

export interface CapturedWorkFolder {
  readonly index: MovedWorkFolder;
  /** Paths that stay on this computer, relative to the folder. */
  readonly left: ReadonlyArray<string>;
}

/**
 * Writes every file that travels into one part at `partPath`, back to back
 * in list order, and lists each with the size and digest of exactly the bytes
 * written. A file up to the Secret guard's read limit is read once, checked,
 * and written from that same read; a larger one travels unread, as a large
 * Code file does.
 */
export async function captureWorkFolderForMove(input: {
  readonly folder: string;
  readonly workingDirectory: ThreadWorkingDirectory;
  readonly partId: string;
  readonly partPath: string;
  /**
   * Called before each file is opened: the moment an outside writer could
   * still swap it for a link. Tests use it to do so.
   */
  readonly beforeReading?: (path: string) => Promise<void>;
  /** Called before each folder inside is listed, the walk's own such moment. */
  readonly beforeListing?: (path: string) => Promise<void>;
}): Promise<CapturedWorkFolder> {
  const walked = await walkWorkFolder(input.folder, input.beforeListing);
  const files: Array<MovedWorkFolder["files"][number]> = [];
  const left = [...walked.left];
  const workingDirectory = Schema.decodeSync(MovedWorkPath)(input.workingDirectory);
  let part: FileHandle | undefined;
  // Where the next file starts in the part; a file that fails partway is cut
  // back off, so every listed file sits exactly at the sum of those before it.
  let offset = 0;
  try {
    for (const file of walked.files) {
      await input.beforeReading?.(file.path);
      const hash = createHash("sha256");
      let bytes = 0;
      const source = await openWalkedFile(join(input.folder, file.path), file);
      if (source.status === "missing") continue;
      if (source.status === "refused") {
        left.push(file.path);
        continue;
      }
      try {
        if (file.bytes <= SECRET_SCAN_LIMIT_BYTES) {
          const content = await source.handle.readFile();
          if (redactSecrets(content.toString("utf8")).redacted) {
            left.push(file.path);
            continue;
          }
          part ??= await open(input.partPath, "w", 0o600);
          hash.update(content);
          await part.write(content, 0, content.byteLength, offset);
          bytes = content.byteLength;
        } else {
          part ??= await open(input.partPath, "w", 0o600);
          const buffer = new Uint8Array(1024 * 1024);
          for (;;) {
            const { bytesRead } = await source.handle.read(buffer, 0, buffer.byteLength, bytes);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await part.write(chunk, 0, bytesRead, offset + bytes);
            bytes += bytesRead;
          }
        }
      } catch {
        await part?.truncate(offset);
        left.push(file.path);
        continue;
      } finally {
        await source.handle.close();
      }
      offset += bytes;
      files.push({
        path: Schema.decodeSync(MovedWorkPath)(file.path),
        bytes,
        sha256: hash.digest("hex"),
        mode: file.mode,
      });
    }
  } finally {
    await part?.close();
  }
  if (part !== undefined && files.length === 0) await rm(input.partPath, { force: true });
  return {
    index: {
      workingDirectory,
      ...(files.length === 0 ? {} : { partId: input.partId }),
      files,
      emptyFolders: walked.emptyFolders.map((path) => Schema.decodeSync(MovedWorkPath)(path)),
      rootMode: walked.rootMode,
      folderModes: carriedFolderModes(
        files.map((entry) => String(entry.path)),
        walked.emptyFolders,
        walked.folderModes,
      ),
    },
    left: left.sort(),
  };
}

/**
 * The permission bits of every folder a carried file or empty folder sits in
 * or is, so each lands with its own. A folder the walk did not record lands
 * private (`0o700`), the narrowest a person can still open.
 */
function carriedFolderModes(
  files: ReadonlyArray<string>,
  emptyFolders: ReadonlyArray<string>,
  modes: ReadonlyMap<string, number>,
): MovedWorkFolder["folderModes"] {
  // An empty folder is itself carried, so it keeps its own bits too, not only
  // the bits of the folders above it.
  const folders = new Set<string>(emptyFolders);
  for (const path of [...files, ...emptyFolders]) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort().map((path) => ({
    path: Schema.decodeSync(MovedWorkPath)(path),
    mode: modes.get(path) ?? 0o700,
  }));
}

/**
 * Opens a file the walk listed, refusing what it no longer is. A file can be
 * swapped for a link, or a folder on its way for one, after the walk: opening
 * by path would then read whatever the link points at, outside the folder.
 * The file is opened without following a link in its last step, and the open
 * handle must be a plain file with the device and inode the walk recorded,
 * which a swapped folder on the way also fails, and the file must still be
 * at exactly its own path, links resolved. Every read is then made through
 * that handle, never by path.
 */
async function openWalkedFile(
  path: string,
  walked: { readonly dev: number; readonly ino: number },
): Promise<
  | { readonly status: "opened"; readonly handle: FileHandle }
  | { readonly status: "missing" }
  | { readonly status: "refused" }
> {
  let handle: FileHandle;
  try {
    handle = await open(path, NO_FOLLOW_READ);
  } catch (error) {
    // A file deleted since the walk has nothing left to carry or keep.
    return isMissing(error) ? { status: "missing" } : { status: "refused" };
  }
  const found = await handle.stat().catch(() => undefined);
  if (
    found === undefined ||
    !found.isFile() ||
    found.dev !== walked.dev ||
    found.ino !== walked.ino ||
    // A folder on the way that was a link while the walk listed it gave the
    // walk an outside file's identity, which the handle then matches; the
    // file must also be at exactly its own path inside the folder.
    (await realpath(path).catch(() => "")) !== path
  ) {
    await handle.close();
    return { status: "refused" };
  }
  return { status: "opened", handle };
}

/** Read-only, never through a link, and never waiting on a named pipe. */
const NO_FOLLOW_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export type LandedWorkFolder =
  | { readonly status: "landed"; readonly workingDirectory: ThreadWorkingDirectory }
  /** Both the thread's path and a fresh one beside it hold something else, or a file did not match. */
  | { readonly status: "refused" };

/**
 * Lands the moved files under the destination Project's main folder `root`:
 * at the thread's own path when nothing is there, otherwise in a fresh
 * folder beside it named for the move. A folder that already holds exactly
 * these files is an earlier try's landing and is used as it is. The files
 * are written into a staging folder of the move's own and renamed into
 * place in one step, so a stop leaves either nothing or the whole folder.
 */
export async function landWorkFolderFromMove(input: {
  readonly root: string;
  readonly index: MovedWorkFolder;
  /** The arrived `work-files` part; undefined when no file travels. */
  readonly partPath: string | undefined;
  readonly moveId: string;
}): Promise<LandedWorkFolder> {
  const { index } = input;
  if (index.files.length > 0 && input.partPath === undefined) return { status: "refused" };
  const rootEntry = await lstat(input.root).catch(() => undefined);
  if (rootEntry === undefined || !rootEntry.isDirectory()) return { status: "refused" };
  const fresh = Schema.decodeUnknownOption(MovedWorkPath)(
    `${index.workingDirectory}-moved-${input.moveId.slice(0, 8)}`,
  );
  const candidates = [index.workingDirectory, ...Option.toArray(fresh)];
  for (const candidate of candidates) {
    const state = await landingState(input.root, candidate, index);
    // Used as it is: a folder that only looks like an earlier landing may be
    // the person's own, and its permission bits are theirs.
    if (state === "ours") return { status: "landed", workingDirectory: candidate };
    if (state === "taken") continue;
    const target = join(input.root, candidate);
    const staging = join(dirname(target), `.octant-move-${input.moveId}`);
    try {
      await mkdir(dirname(target), { recursive: true });
      // The staging folder is this move's own, so an earlier try's is restarted.
      await rm(staging, { recursive: true, force: true });
      // Private while the files are written; each folder takes its own bits
      // once its contents are in place, so none is ever wider than it was.
      await mkdir(staging, { mode: 0o700 });
      await writeLandedFiles(staging, index, input.partPath);
      for (const folder of [...index.folderModes].reverse()) {
        await chmod(join(staging, folder.path), folder.mode);
      }
      // The folder takes its own bits before it lands, so a landing found
      // later already has them and nothing changes an existing folder's.
      await chmod(staging, index.rootMode);
      // Rename replaces only an empty folder; one that gained an entry
      // since the check refuses, and nothing of the person's is touched.
      await rename(staging, target);
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      return { status: "refused" };
    }
    return { status: "landed", workingDirectory: candidate };
  }
  return { status: "refused" };
}

async function writeLandedFiles(
  staging: string,
  index: MovedWorkFolder,
  partPath: string | undefined,
): Promise<void> {
  for (const folder of index.emptyFolders) {
    await mkdir(join(staging, folder), { recursive: true, mode: 0o700 });
  }
  if (partPath === undefined) return;
  const part = await open(partPath, "r");
  try {
    const expected = index.files.reduce((total, file) => total + file.bytes, 0);
    if ((await part.stat()).size !== expected) throw new Error("The files part has another size.");
    let offset = 0;
    for (const file of index.files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      // Opened with its own bits, which the umask can only narrow, so a
      // private file is never readable by others even while it is written.
      const out = await open(target, "wx", file.mode);
      const hash = createHash("sha256");
      try {
        let remaining = file.bytes;
        while (remaining > 0) {
          const length = Math.min(remaining, 1024 * 1024);
          const buffer = new Uint8Array(length);
          const { bytesRead } = await part.read(buffer, 0, length, offset);
          if (bytesRead === 0) throw new Error("The files part ended early.");
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await out.write(chunk);
          offset += bytesRead;
          remaining -= bytesRead;
        }
        // Exactly its bits, which the umask may have narrowed on open.
        await out.chmod(file.mode);
      } finally {
        await out.close();
      }
      if (hash.digest("hex") !== file.sha256) throw new Error("A moved file did not match.");
    }
  } finally {
    await part.close();
  }
}

/**
 * Whether a path under the destination root is free for the moved files
 * (nothing there, or an empty folder), already holds exactly them, or holds
 * something else. A link or a file anywhere on the way counts as taken.
 */
async function landingState(
  root: string,
  path: string,
  index: MovedWorkFolder,
): Promise<"free" | "ours" | "taken"> {
  const components = path.split("/");
  for (let depth = 1; depth <= components.length; depth += 1) {
    const entry = await lstat(join(root, ...components.slice(0, depth))).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (entry === undefined) return "free";
    if (!entry.isDirectory()) return "taken";
  }
  return folderHoldsExactly(join(root, path), index);
}

async function folderHoldsExactly(
  folder: string,
  index: MovedWorkFolder,
): Promise<"free" | "ours" | "taken"> {
  const expectedFiles = new Map(index.files.map((file) => [String(file.path), file]));
  const expectedFolders = new Set<string>(index.emptyFolders.map(String));
  for (const path of [...expectedFiles.keys(), ...index.emptyFolders.map(String)]) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      expectedFolders.add(parts.slice(0, depth).join("/"));
    }
  }
  let seen = 0;
  let level: ReadonlyArray<string> = [""];
  while (level.length > 0) {
    const next: string[] = [];
    for (const parent of level) {
      for (const child of await readdir(join(folder, parent), { withFileTypes: true })) {
        const path = parent === "" ? child.name : `${parent}/${child.name}`;
        seen += 1;
        if (child.isDirectory() && !child.isSymbolicLink() && expectedFolders.has(path)) {
          next.push(path);
          continue;
        }
        const expected = expectedFiles.get(path);
        if (!child.isFile() || child.isSymbolicLink() || expected === undefined) return "taken";
        const size = (await lstat(join(folder, path))).size;
        if (
          size !== expected.bytes ||
          (await plainFileSha256(join(folder, path))) !== expected.sha256
        ) {
          return "taken";
        }
      }
    }
    level = next;
  }
  if (seen === 0) return "free";
  return seen === expectedFiles.size + expectedFolders.size ? "ours" : "taken";
}

export type SettledWorkFolder =
  /** Everything in it travelled unchanged, so it was removed (or an earlier erase already had). */
  | { readonly status: "removed" }
  /** Something in it did not travel, so the folder stays with exactly that. */
  | { readonly status: "kept"; readonly keptFiles: ReadonlyArray<string> };

/**
 * The folder a move's clean-up sets files aside in: beside the source
 * folder, so on the same file system, and named for the move, so a clean-up
 * that stopped partway finds it again after a restart. Each file in it is
 * named by its position in the move's file list, which the source keeps,
 * so what it was needs nothing held in memory and no name grows with its path.
 */
export function movedAsideFolder(folder: string, moveId: string): string {
  return join(dirname(folder), `.${basename(folder)}-octant-moving-${moveId.slice(0, 8)}`);
}

/**
 * Clears the source folder once its thread moved, deleting only what it has
 * just proved travelled. A frozen Work thread stops its turns but not an
 * editor or a terminal the person has open there, so a check of the whole
 * folder followed by a recursive removal could destroy a file written in
 * between. Instead each file that travelled is first renamed into the move's
 * set-aside folder, so a later write to its path makes a new file there, and
 * only the moved file is compared and deleted. One that no longer matches is
 * put back, or kept beside its path as `-kept` when that path has been taken
 * again. Folders are then removed bottom-up one at a time, which fails on any
 * folder that still holds something, so anything added during the clean-up
 * stays. Whatever is left keeps the folder and is listed.
 *
 * A clean-up that stopped after setting a file aside (the host stopped, or
 * the call failed) left that file in the set-aside folder, possibly the only
 * copy of an edit made after the move packed. Every run therefore first
 * settles whatever an earlier run left there, the same way, before it sets
 * anything else aside, and reports `removed` only when nothing is left there
 * or in the folder.
 */
export async function settleMovedWorkFolder(input: {
  readonly folder: string;
  readonly index: MovedWorkFolder;
  readonly moveId: string;
  /**
   * Called after a file is moved aside and before it is compared: the moment
   * an outside writer could still change the folder, or the host could stop.
   * Tests use it to write there, or to throw.
   */
  readonly afterMovedAside?: (path: string) => Promise<void>;
}): Promise<SettledWorkFolder> {
  const folder = input.folder;
  const trash = movedAsideFolder(folder, input.moveId);
  const files = input.index.files;

  /** Deletes a set-aside file that matches what travelled, or puts it back. */
  const settleAside = async (
    aside: string,
    file: MovedWorkFolder["files"][number],
    /** The file as it was found before it was set aside; a read must see that same file. */
    identity?: { readonly dev: number; readonly ino: number },
  ) => {
    const travelled =
      (await lstat(aside)
        .then((found) => (found.isFile() ? found.size : -1))
        .catch(() => -1)) === file.bytes &&
      (await plainFileSha256(aside, identity)) === file.sha256;
    if (travelled) {
      await rm(aside, { force: true });
      return;
    }
    const original = join(folder, String(file.path));
    // Only into the folder itself, never through a link; otherwise it stays
    // set aside, where the listing below names it.
    if (!(await folderIsItself(folder))) return;
    if (!(await plainFoldersOnTheWay(folder, String(file.path), { create: true }))) return;
    for (const name of [original, `${original}-kept`, `${original}-kept-2`, `${original}-kept-3`]) {
      if (await placeWithoutOverwriting(aside, name)) return;
    }
  };

  // What an earlier run left set aside, first.
  for (const name of await readdir(trash).catch(() => [])) {
    const position = /^[0-9]+$/.test(name) ? Number(name) : undefined;
    const file = position === undefined ? undefined : files[position];
    if (file !== undefined) await settleAside(join(trash, name), file);
  }

  const top = await lstat(folder).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (top !== undefined && (await folderIsItself(folder))) {
    await mkdir(trash, { recursive: true, mode: 0o700 });
    for (const [position, file] of files.entries()) {
      const path = String(file.path);
      const original = join(folder, path);
      const aside = join(trash, String(position));
      // A folder on the way that became a link would lead outside the folder.
      if (!(await plainFoldersOnTheWay(folder, path, { create: false }))) continue;
      const entry = await lstat(original).catch(() => undefined);
      if (entry === undefined || !entry.isFile()) continue;
      // A name still taken in the set-aside folder is never renamed over.
      if (
        await lstat(aside).then(
          () => true,
          () => false,
        )
      )
        continue;
      try {
        await rename(original, aside);
      } catch {
        continue;
      }
      await input.afterMovedAside?.(path);
      await settleAside(aside, file, entry);
    }
    // Only folders that travelled: an empty folder the move left out (ignored,
    // past the entry limit, or made since it packed) stays, and so does the
    // folder holding it, which the listing below then names.
    for (const directory of carriedFoldersDeepestFirst(input.index)) {
      if (!(await plainFoldersOnTheWay(folder, directory, { create: false }))) continue;
      await rmdir(join(folder, directory)).catch(() => undefined);
    }
    await rmdir(folder).catch(() => undefined);
  }

  const trashLeft = await readdir(trash).catch(() => []);
  if (trashLeft.length === 0) await rmdir(trash).catch(() => undefined);
  const remains = await lstat(folder).then(
    () => true,
    () => false,
  );
  if (!remains && trashLeft.length === 0) return { status: "removed" };
  if (top !== undefined && remains && !(await folderIsItself(folder))) {
    // A folder that turned into a link, or moved, was not touched.
    return { status: "kept", keptFiles: [] };
  }
  let kept: Array<string> = [];
  if (remains) {
    try {
      const walked = await walkWorkFolder(folder);
      kept = [...walked.files.map((entry) => entry.path), ...walked.emptyFolders, ...walked.left];
    } catch {
      kept = [];
    }
  }
  // A file that could be neither put back nor kept beside its path is still
  // set aside, named relative to the folder so it can be found.
  for (const name of trashLeft) kept.push(join(relative(folder, trash), name));
  return { status: "kept", keptFiles: kept.sort() };
}

/** Whether the folder is a real folder at exactly its own path, not a link. */
async function folderIsItself(folder: string): Promise<boolean> {
  const entry = await lstat(folder).catch(() => undefined);
  return (
    entry !== undefined &&
    entry.isDirectory() &&
    (await realpath(folder).catch(() => "")) === folder
  );
}

/** Moves a file to `target` only when nothing is there, never replacing what is. */
async function placeWithoutOverwriting(from: string, target: string): Promise<boolean> {
  try {
    await link(from, target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    // A file system without hard links: copy, refusing an existing target.
    try {
      await copyFile(from, target, fsConstants.COPYFILE_EXCL);
    } catch {
      return false;
    }
  }
  await rm(from, { force: true });
  return true;
}

/**
 * Whether every folder between `root` and the file is a plain folder, not a
 * link. With `create`, a missing one is made, one level at a time, so a file
 * put back after its folders were cleared lands where it was.
 */
async function plainFoldersOnTheWay(
  root: string,
  path: string,
  options: { readonly create: boolean },
): Promise<boolean> {
  const parts = path.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    const step = join(root, ...parts.slice(0, depth));
    let entry = await lstat(step).catch(() => undefined);
    if (entry === undefined && options.create) {
      await mkdir(step).catch(() => undefined);
      entry = await lstat(step).catch(() => undefined);
    }
    if (entry === undefined || !entry.isDirectory()) return false;
  }
  return true;
}

/** The folders a move carried, empty or holding a carried file, deepest first. */
function carriedFoldersDeepestFirst(index: MovedWorkFolder): ReadonlyArray<string> {
  const folders = new Set<string>(index.emptyFolders.map(String));
  for (const file of index.files) {
    const parts = String(file.path).split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
}

/**
 * The digest of a plain file, read through a handle opened without following
 * a link; undefined for a link, anything else, or a file whose device and
 * inode are not the ones `expected` names.
 */
async function plainFileSha256(
  path: string,
  expected?: { readonly dev: number; readonly ino: number },
): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, NO_FOLLOW_READ);
  } catch {
    return undefined;
  }
  try {
    const found = await handle.stat();
    if (!found.isFile()) return undefined;
    if (expected !== undefined && (found.dev !== expected.dev || found.ino !== expected.ino)) {
      return undefined;
    }
    const hash = createHash("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Whether Git ignore rules apply to the folder: it sits in a Git working tree. */
async function insideGitWorkTree(folder: string): Promise<boolean> {
  const answer = await runGit(folder, ["rev-parse", "--is-inside-work-tree"], "");
  return answer.code === 0 && answer.stdout.trim() === "true";
}

/**
 * The paths Git ignores among `paths` (relative to the folder; a folder ends
 * in `/` so folder-only rules match), without the trailing slash. A tracked
 * file is never ignored. A check that fails throws rather than letting an
 * ignored file travel.
 */
async function ignoredPaths(
  folder: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const answer = await runGit(
    folder,
    ["check-ignore", "-z", "--stdin"],
    paths.map((path) => `${path}\0`).join(""),
  );
  // 1 means nothing among them is ignored.
  if (answer.code !== 0 && answer.code !== 1) throw new Error("Git could not check ignore rules.");
  return new Set(
    answer.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path)),
  );
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  stdin: string,
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
