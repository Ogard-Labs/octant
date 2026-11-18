import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { claudeProjectFolderName } from "./claudeProcess";

/**
 * Copies one Claude session's own files from one account's directory into
 * another's, so a thread moved to another account of the same provider resumes
 * its session there (maintainer decision, 2026-11-17).
 *
 * The runtime keeps a session as `projects/<folder>/<session>.jsonl`, with its
 * subagent transcripts and saved tool results in `projects/<folder>/<session>/`
 * and its rewind checkpoints in `file-history/<session>/` when it made any. The
 * folder is named after the canonical working directory, so it is the same for
 * both accounts on one host. Only those three paths of that one session are
 * read: nothing else in either account directory is listed, so no other
 * session, memory file, setting or sign-in is ever copied.
 *
 * The copy runs in the host process, never in an agent's sandbox, and it
 * refuses rather than guesses: a session id that is not a UUID, a path that is
 * a symbolic link anywhere below either account directory, a file that
 * resolves outside its account, an account directory inside the other, and an
 * existing destination file that differs. A destination file with the same
 * bytes is left as it is, so a repeated move does not refuse itself.
 */
export type ClaudeAccountSessionCopy =
  | {
      readonly status: "copied";
      /** Removes what this copy wrote, for a move that then could not take the session up. */
      readonly discard: () => Promise<void>;
    }
  | { readonly status: "refused"; readonly reason: ClaudeAccountSessionCopyRefusal };

export type ClaudeAccountSessionCopyRefusal =
  | "invalid-session-id"
  | "account-directory-unavailable"
  | "account-directories-overlap"
  | "session-missing"
  | "symbolic-link"
  | "outside-account"
  | "unexpected-entry"
  | "destination-differs"
  | "session-too-large"
  | "copy-failed";

/** Claude Code names every session with a UUID; anything else could name a path. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * File names an account keeps its sign-in or settings in. None belongs to a
 * session, and one found inside a session's folder is skipped unread.
 */
const ACCOUNT_STATE_FILE_NAMES = new Set([
  ".credentials.json",
  "credentials.json",
  "auth.json",
  ".claude.json",
  "settings.json",
  "settings.local.json",
]);

/** The most files one session's folders may hold before the copy refuses. */
const MAX_SESSION_FILES = 10_000;

/**
 * The most bytes one session may hold before the copy refuses. Each file is
 * read whole into the host process, so a session past this hands over as
 * text rather than risk the host's memory.
 */
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

class CopyRefused extends Error {
  readonly reason: ClaudeAccountSessionCopyRefusal;
  constructor(reason: ClaudeAccountSessionCopyRefusal) {
    super(reason);
    this.reason = reason;
  }
}

interface PlannedFile {
  /** Path below the account directory, the same in both accounts. */
  readonly relativePath: string;
  /** Whether an identical file is already in the destination. */
  readonly present: boolean;
}

export async function copyClaudeAccountSession(input: {
  readonly fromDirectory: string;
  readonly toDirectory: string;
  readonly projectRoot: string;
  readonly sessionId: string;
}): Promise<ClaudeAccountSessionCopy> {
  if (!CLAUDE_SESSION_ID.test(input.sessionId))
    return { status: "refused", reason: "invalid-session-id" };
  const created: { files: string[]; directories: string[] } = { files: [], directories: [] };
  try {
    const from = await accountRoot(input.fromDirectory);
    const to = await accountRoot(input.toDirectory);
    if (from === to || inside(from, to) || inside(to, from))
      throw new CopyRefused("account-directories-overlap");
    const folder = await sessionFolderName(from, input.projectRoot, input.sessionId);
    const transcript = join("projects", folder, `${input.sessionId}.jsonl`);
    const budget = { bytes: 0 };
    const planned: PlannedFile[] = [await planFile(from, to, transcript, budget)];
    for (const directory of [
      join("projects", folder, input.sessionId),
      join("file-history", input.sessionId),
    ]) {
      const kind = await entryKind(from, directory);
      if (kind === "missing") continue;
      if (kind !== "directory") throw new CopyRefused("unexpected-entry");
      for (const file of await filesBelow(from, directory)) {
        planned.push(await planFile(from, to, file, budget));
      }
    }
    for (const file of planned) {
      if (!file.present) await writeCopy(from, to, file.relativePath, created);
    }
    return { status: "copied", discard: () => removeCreated(created) };
  } catch (error) {
    await removeCreated(created);
    return {
      status: "refused",
      reason: error instanceof CopyRefused ? error.reason : "copy-failed",
    };
  }
}

/** The account directory, resolved once; every path below it is then checked link by link. */
async function accountRoot(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new CopyRefused("account-directory-unavailable");
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory())
      throw new CopyRefused("account-directory-unavailable");
    return resolved;
  } catch (error) {
    if (error instanceof CopyRefused) throw error;
    throw new CopyRefused("account-directory-unavailable");
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * The session's folder under `projects/`. The runtime names it after the
 * canonical working directory; the folder as given is tried after it, for a
 * session written before the directory resolved to where it does now.
 */
async function sessionFolderName(
  from: string,
  projectRoot: string,
  sessionId: string,
): Promise<string> {
  const candidates = [projectRoot];
  try {
    candidates.unshift(await realpath(projectRoot));
  } catch {
    // A folder that no longer resolves is still named as it was given.
  }
  for (const candidate of new Set(candidates)) {
    const folder = claudeProjectFolderName(candidate.normalize("NFC"));
    if ((await entryKind(from, join("projects", folder, `${sessionId}.jsonl`))) !== "missing")
      return folder;
  }
  throw new CopyRefused("session-missing");
}

/**
 * What a path below an account directory is, after checking that no part of
 * it below the account directory is a symbolic link.
 */
async function entryKind(
  root: string,
  relativePath: string,
): Promise<"missing" | "file" | "directory"> {
  const parts = relativePath.split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (part.length === 0 || part === "." || part === "..")
      throw new CopyRefused("outside-account");
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error;
    }
    if (stats.isSymbolicLink()) throw new CopyRefused("symbolic-link");
    const last = index === parts.length - 1;
    if (!last && !stats.isDirectory()) throw new CopyRefused("unexpected-entry");
    if (last) {
      if (stats.isDirectory()) return "directory";
      if (stats.isFile()) return "file";
      throw new CopyRefused("unexpected-entry");
    }
  }
  return "missing";
}

/** Every regular file below a session folder, refusing a link or any other kind of entry. */
async function filesBelow(root: string, directory: string): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const pending = [directory];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of await readdir(join(root, next), { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isSymbolicLink()) throw new CopyRefused("symbolic-link");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        if (ACCOUNT_STATE_FILE_NAMES.has(entry.name)) continue;
        files.push(path);
        if (files.length > MAX_SESSION_FILES) throw new CopyRefused("unexpected-entry");
      } else throw new CopyRefused("unexpected-entry");
    }
  }
  return files;
}

async function planFile(
  from: string,
  to: string,
  relativePath: string,
  budget: { bytes: number },
): Promise<PlannedFile> {
  if ((await entryKind(from, relativePath)) !== "file") throw new CopyRefused("session-missing");
  await assertResolvesInside(from, relativePath);
  const source = await lstat(join(from, relativePath));
  // A file with a second name could be another file of the account (its
  // sign-in, say) linked into the session's folder, so it is never copied.
  if (source.nlink > 1) throw new CopyRefused("unexpected-entry");
  budget.bytes += source.size;
  if (budget.bytes > MAX_SESSION_BYTES) throw new CopyRefused("session-too-large");
  const destination = await entryKind(to, relativePath);
  if (destination === "directory") throw new CopyRefused("destination-differs");
  if (destination === "missing") return { relativePath, present: false };
  await assertResolvesInside(to, relativePath);
  if ((await lstat(join(to, relativePath))).size !== source.size)
    throw new CopyRefused("destination-differs");
  const [content, existing] = await Promise.all([
    readWithoutFollowing(join(from, relativePath)),
    readWithoutFollowing(join(to, relativePath)),
  ]);
  if (!content.equals(existing)) throw new CopyRefused("destination-differs");
  return { relativePath, present: true };
}

async function assertResolvesInside(root: string, relativePath: string): Promise<void> {
  const resolved = await realpath(join(root, relativePath));
  if (!inside(root, resolved)) throw new CopyRefused("outside-account");
}

async function readWithoutFollowing(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Writes one file of the session into the destination account, owner-only,
 * making the folders it needs owner-only too. The file is opened exclusively
 * and without following a link, so a file or link that appeared since the
 * plan was made refuses the copy instead of being written through.
 */
async function writeCopy(
  from: string,
  to: string,
  relativePath: string,
  created: { files: string[]; directories: string[] },
): Promise<void> {
  const parts = relativePath.split(sep);
  let current = to;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
      created.directories.push(current);
    } catch (error) {
      if (!isExisting(error)) throw error;
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new CopyRefused("symbolic-link");
      if (!stats.isDirectory()) throw new CopyRefused("unexpected-entry");
    }
  }
  const content = await readWithoutFollowing(join(from, relativePath));
  const destination = join(to, relativePath);
  let handle;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isExisting(error)) throw new CopyRefused("destination-differs");
    throw error;
  }
  created.files.push(destination);
  try {
    await handle.writeFile(content);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function removeCreated(created: { files: string[]; directories: string[] }): Promise<void> {
  for (const file of created.files.splice(0).reverse()) {
    await unlink(file).catch(() => undefined);
  }
  // Only folders this copy made, deepest first, and only while empty.
  for (const directory of created.directories.splice(0).reverse()) {
    await rmdir(directory).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
