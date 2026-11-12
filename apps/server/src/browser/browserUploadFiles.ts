import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { MAX_BROWSER_UPLOAD_FILES, MAX_BROWSER_UPLOAD_FILE_BYTES } from "@octant/contracts";

/** One file an upload would send, as the person is asked about it. */
export interface BrowserUploadFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** The file's identity when it was checked, so a swap afterwards is caught. */
  readonly device: string;
  readonly inode: string;
  readonly linkCount: number;
  /** Digest of the staged bytes, present only after a bounded private copy. */
  readonly sha256?: string;
}

export type BrowserUploadResolution =
  | { readonly status: "resolved"; readonly files: ReadonlyArray<BrowserUploadFile> }
  | {
      readonly status: "refused";
      readonly reason:
        | "upload-invalid-files"
        | "upload-outside-workspace"
        | "upload-symlink"
        | "upload-not-a-file"
        | "upload-too-large"
        | "upload-not-found";
    };

/**
 * Resolve the files an agent named for an upload inside the thread's
 * workspace, or refuse. A file leaves this computer through a page, so only a
 * plain file that is really inside the workspace may go: no absolute path, no
 * path that climbs out, no symbolic link at the file or anywhere between it and
 * the workspace, and nothing over the size limit (the person's Settings limit
 * where the caller passes it, the default otherwise).
 */
export async function resolveBrowserUploadFiles(
  workspaceRoot: string,
  named: ReadonlyArray<string>,
  maxFileBytes: number = MAX_BROWSER_UPLOAD_FILE_BYTES,
): Promise<BrowserUploadResolution> {
  if (named.length < 1 || named.length > MAX_BROWSER_UPLOAD_FILES)
    return { status: "refused", reason: "upload-invalid-files" };
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch {
    return { status: "refused", reason: "upload-not-found" };
  }
  const files: BrowserUploadFile[] = [];
  for (const entry of named) {
    if (isAbsolute(entry) || entry.includes("\0")) {
      return { status: "refused", reason: "upload-outside-workspace" };
    }
    const candidate = resolve(root, entry);
    const fromRoot = relative(root, candidate);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../")) {
      return { status: "refused", reason: "upload-outside-workspace" };
    }
    let stats;
    try {
      stats = await lstat(candidate, { bigint: true });
    } catch {
      return { status: "refused", reason: "upload-not-found" };
    }
    if (stats.isSymbolicLink()) return { status: "refused", reason: "upload-symlink" };
    if (!stats.isFile()) return { status: "refused", reason: "upload-not-a-file" };
    // A link in a folder between the workspace and the file moves the real
    // file somewhere else; the canonical path is then not the one named.
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      return { status: "refused", reason: "upload-not-found" };
    }
    if (canonical !== candidate) return { status: "refused", reason: "upload-symlink" };
    if (stats.size > BigInt(maxFileBytes)) {
      return { status: "refused", reason: "upload-too-large" };
    }
    if (files.some((file) => file.path === candidate)) continue;
    files.push({
      path: candidate,
      name: basename(candidate),
      sizeBytes: Number(stats.size),
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      linkCount: Number(stats.nlink),
    });
  }
  return { status: "resolved", files };
}

/**
 * Resolve an upload's files, copy exactly those, and put `ask` to the caller:
 * the person's answer below Full access, none at Full access. The path and
 * size checks run before `ask` at every level.
 *
 * The runtime is handed the copies, never the workspace paths. An agent with a
 * shell in the workspace could otherwise swap a checked file for a link to
 * something else while the person reads the question, and the runtime, which
 * follows links, would send that instead. Each copy is read from a descriptor
 * opened without following a link and matched to the file that was checked.
 * The caller releases the copies once the action is done.
 */
export async function admitBrowserUpload(input: {
  readonly workspaceRoot: string | undefined;
  readonly files: ReadonlyArray<string>;
  /** The person's per-file limit; absent, the default. */
  readonly maxFileBytes?: number;
  readonly ask: (
    files: ReadonlyArray<BrowserUploadFile>,
  ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
}): Promise<
  | {
      readonly status: "admitted";
      readonly paths: ReadonlyArray<string>;
      readonly release: () => Promise<void>;
    }
  | { readonly status: "refused"; readonly reason: string }
> {
  const prepared = await prepareBrowserUpload(input);
  if (prepared.status === "refused") return prepared;
  try {
    const outcome = await input.ask(prepared.files);
    if (outcome !== "approved") {
      await prepared.release();
      return { status: "refused", reason: `browser-upload-${outcome}` };
    }
    return { status: "admitted", paths: prepared.paths, release: prepared.release };
  } catch (error) {
    await prepared.release();
    throw error;
  }
}

/** Review and execution both identify the same bounded staged bytes. */
export async function prepareBrowserUpload(input: {
  readonly workspaceRoot: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly maxFileBytes?: number;
}): Promise<
  | {
      readonly status: "prepared";
      readonly files: ReadonlyArray<BrowserUploadFile & { readonly sha256: string }>;
      readonly paths: ReadonlyArray<string>;
      readonly release: () => Promise<void>;
    }
  | { readonly status: "refused"; readonly reason: string }
> {
  if (input.workspaceRoot === undefined) return { status: "refused", reason: "upload-unavailable" };
  const resolved = await resolveBrowserUploadFiles(
    input.workspaceRoot,
    input.files,
    input.maxFileBytes,
  );
  if (resolved.status === "refused") return resolved;
  let staging: string;
  try {
    staging = await mkdtemp(join(tmpdir(), "octant-browser-upload-"));
  } catch {
    return { status: "refused", reason: "upload-unavailable" };
  }
  const release = () => rm(staging, { recursive: true, force: true });
  try {
    const paths: string[] = [];
    const files: Array<BrowserUploadFile & { readonly sha256: string }> = [];
    for (const [index, file] of resolved.files.entries()) {
      const folder = join(staging, String(index));
      await mkdir(folder, { mode: 0o700 });
      const copy = join(folder, file.name);
      const copied = await copyCheckedFile(file, copy);
      if (copied === undefined) {
        await release();
        return { status: "refused", reason: "upload-changed" };
      }
      paths.push(copy);
      files.push({ ...file, ...copied });
    }
    return { status: "prepared", paths, files, release };
  } catch {
    await release();
    return { status: "refused", reason: "upload-unavailable" };
  }
}

/** Copy one checked file, refusing it if it is no longer the file that was checked. */
async function copyCheckedFile(
  file: BrowserUploadFile,
  copy: string,
): Promise<{ readonly sha256: string; readonly linkCount: number } | undefined> {
  let handle;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      stats.dev.toString() !== file.device ||
      stats.ino.toString() !== file.inode ||
      stats.size !== BigInt(file.sizeBytes)
    ) {
      return undefined;
    }
    let bytes = 0;
    const digest = createHash("sha256");
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        // The size checked at resolution already met the limit, so staying at
        // or under it keeps the copy within the limit too.
        if (bytes > file.sizeBytes) {
          callback(new Error("Upload source changed while copying."));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        bounded,
        createWriteStream(copy, { mode: 0o600 }),
      );
    } catch {
      return undefined;
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytes !== file.sizeBytes ||
      after.size !== BigInt(file.sizeBytes) ||
      after.dev.toString() !== file.device ||
      after.ino.toString() !== file.inode
    )
      return undefined;
    return { sha256: digest.digest("hex"), linkCount: Number(after.nlink) };
  } finally {
    await handle.close();
  }
}

/** The sentence a person reads before files leave this computer. */
export function browserUploadSummary(
  origin: string,
  files: ReadonlyArray<BrowserUploadFile>,
): string {
  const named = files.map((file) => `${file.name} (${formatBytes(file.sizeBytes)})`).join(", ");
  return `Let the agent upload ${named} to ${origin}?`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
