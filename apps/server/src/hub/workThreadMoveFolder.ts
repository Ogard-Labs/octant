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
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
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
      mode: Schema.Int.pipe(Schema.between(0, 0o777)),
    }).annotations(strict),
  ).pipe(Schema.maxItems(MOVED_WORK_FOLDER_ENTRIES_MAX)),
  emptyFolders: Schema.Array(MovedWorkPath).pipe(Schema.maxItems(MOVED_WORK_FOLDER_ENTRIES_MAX)),
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
 * path is absolute and compared as written; the caller resolves each from
 * the host's own Project records.
 */
export function workThreadOwnFolder(input: {
  readonly workingFolder:
    | { readonly kind: "main"; readonly root: string }
    | { readonly kind: "extra" }
    | { readonly kind: "unavailable" };
  readonly workingDirectory: ThreadWorkingDirectory | undefined;
  /** Where every other Work thread on this host that is not deleted works. */
  readonly otherThreadFolders: ReadonlyArray<string>;
  /** Every folder every Project on this host is bound to, main and extra. */
  readonly projectFolders: ReadonlyArray<string>;
}): WorkThreadFolder {
  const { workingFolder, workingDirectory } = input;
  if (workingFolder.kind === "unavailable") return { status: "stays", reason: "unavailable" };
  if (workingFolder.kind === "extra") return { status: "stays", reason: "extra-folder" };
  if (workingDirectory === undefined || workingDirectory === ".") {
    return { status: "stays", reason: "project-folder" };
  }
  const folder = join(workingFolder.root, workingDirectory);
  const isInside = (other: string) => {
    const path = relative(folder, other);
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
  return workThreadOwnFolder({
    workingFolder,
    workingDirectory: input.thread.workingDirectory,
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

interface WalkedFolder {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly mode: number;
  }>;
  readonly emptyFolders: ReadonlyArray<string>;
  /** Entries that never travel: ignored, `.git`, links, special files, unnamable paths, past the bound. */
  readonly left: ReadonlyArray<string>;
}

/**
 * Lists what a move of the folder would carry and what stays, following no
 * link. The folder itself must be a real folder at exactly that path, or the
 * walk throws: a link anywhere in it would put the files elsewhere.
 */
async function walkWorkFolder(folder: string): Promise<WalkedFolder> {
  const top = await lstat(folder);
  if (!top.isDirectory() || (await realpath(folder)) !== folder) {
    throw new Error("The Work folder is not a plain folder at its own path.");
  }
  const files: Array<{ path: string; bytes: number; mode: number }> = [];
  const emptyFolders: string[] = [];
  const left: string[] = [];
  const ignoring = await insideGitWorkTree(folder);
  // Breadth first, one ignore check per depth, so an ignored folder (build
  // output, installed dependencies) is named once and never walked.
  let level: ReadonlyArray<string> = [""];
  while (level.length > 0) {
    const entries: Array<{ path: string; kind: "file" | "folder" | "other" }> = [];
    for (const parent of level) {
      const children = await readdir(join(folder, parent), { withFileTypes: true });
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
      else if (entry.kind === "folder") next.push(entry.path);
      else {
        // A file deleted since the folder was listed has nothing to carry or keep.
        const found = await lstat(join(folder, entry.path)).catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
        if (found !== undefined) {
          files.push({ path: entry.path, bytes: found.size, mode: found.mode & 0o777 });
        }
      }
    }
    level = next;
  }
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort((a, b) => byPath(a.path, b.path));
  emptyFolders.sort(byPath);
  const room = MOVED_WORK_FOLDER_ENTRIES_MAX;
  const keptFiles = files.slice(0, room);
  const keptFolders = emptyFolders.slice(0, room - keptFiles.length);
  return {
    files: keptFiles,
    emptyFolders: keptFolders,
    left: [
      ...left,
      ...files.slice(keptFiles.length).map((file) => file.path),
      ...emptyFolders.slice(keptFolders.length),
    ].sort(byPath),
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
}): Promise<CapturedWorkFolder> {
  const walked = await walkWorkFolder(input.folder);
  const files: Array<MovedWorkFolder["files"][number]> = [];
  const left = [...walked.left];
  const workingDirectory = Schema.decodeSync(MovedWorkPath)(input.workingDirectory);
  let part: FileHandle | undefined;
  // Where the next file starts in the part; a file that fails partway is cut
  // back off, so every listed file sits exactly at the sum of those before it.
  let offset = 0;
  try {
    for (const file of walked.files) {
      const source = join(input.folder, file.path);
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        if (file.bytes <= SECRET_SCAN_LIMIT_BYTES) {
          const content = await readFile(source);
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
          for await (const chunk of createReadStream(source)) {
            if (!(chunk instanceof Uint8Array)) continue;
            hash.update(chunk);
            await part.write(chunk, 0, chunk.byteLength, offset + bytes);
            bytes += chunk.byteLength;
          }
        }
      } catch (error) {
        await part?.truncate(offset);
        // A file deleted since the walk has nothing left to carry or keep.
        if (!isMissing(error)) left.push(file.path);
        continue;
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
    },
    left: left.sort(),
  };
}

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
    if (state === "ours") return { status: "landed", workingDirectory: candidate };
    if (state === "taken") continue;
    const target = join(input.root, candidate);
    const staging = join(dirname(target), `.octant-move-${input.moveId}`);
    try {
      await mkdir(dirname(target), { recursive: true });
      // The staging folder is this move's own, so an earlier try's is restarted.
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging);
      await writeLandedFiles(staging, index, input.partPath);
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
    await mkdir(join(staging, folder), { recursive: true });
  }
  if (partPath === undefined) return;
  const part = await open(partPath, "r");
  try {
    const expected = index.files.reduce((total, file) => total + file.bytes, 0);
    if ((await part.stat()).size !== expected) throw new Error("The files part has another size.");
    let offset = 0;
    for (const file of index.files) {
      const target = join(staging, file.path);
      await mkdir(dirname(target), { recursive: true });
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
        if (size !== expected.bytes || (await fileSha256(join(folder, path))) !== expected.sha256) {
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
  const settleAside = async (aside: string, file: MovedWorkFolder["files"][number]) => {
    const travelled =
      (await lstat(aside)
        .then((found) => (found.isFile() ? found.size : -1))
        .catch(() => -1)) === file.bytes &&
      (await fileSha256(aside).catch(() => "")) === file.sha256;
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
      await settleAside(aside, file);
    }
    for (const directory of await foldersDeepestFirst(folder)) {
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

/** Every folder inside `root`, deepest first, found without following a link. */
async function foldersDeepestFirst(root: string): Promise<ReadonlyArray<string>> {
  const found: string[] = [];
  let level: ReadonlyArray<string> = [""];
  while (level.length > 0) {
    const next: string[] = [];
    for (const parent of level) {
      const children = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (!child.isDirectory()) continue;
        next.push(parent === "" ? child.name : `${parent}/${child.name}`);
      }
    }
    found.push(...next);
    level = next;
  }
  return found.reverse();
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (chunk instanceof Uint8Array) hash.update(chunk);
  }
  return hash.digest("hex");
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
