import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { MAX_BROWSER_UPLOAD_FILE_BYTES } from "@octant/contracts";

/** One file an upload would send, as the person is asked about it. */
export interface BrowserUploadFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  /** The file's identity when it was checked, so a swap afterwards is caught. */
  readonly device: number;
  readonly inode: number;
}

export type BrowserUploadResolution =
  | { readonly status: "resolved"; readonly files: ReadonlyArray<BrowserUploadFile> }
  | {
      readonly status: "refused";
      readonly reason:
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
 * the workspace, and nothing over the size limit.
 */
export async function resolveBrowserUploadFiles(
  workspaceRoot: string,
  named: ReadonlyArray<string>,
): Promise<BrowserUploadResolution> {
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
      stats = await lstat(candidate);
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
    if (stats.size > MAX_BROWSER_UPLOAD_FILE_BYTES) {
      return { status: "refused", reason: "upload-too-large" };
    }
    if (files.some((file) => file.path === candidate)) continue;
    files.push({
      path: candidate,
      name: basename(candidate),
      sizeBytes: stats.size,
      device: stats.dev,
      inode: stats.ino,
    });
  }
  return { status: "resolved", files };
}

/**
 * Resolve an upload's files, copy exactly those, and ask the person about
 * them, each time. An upload is never remembered: the answer covers these
 * files to this origin once.
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
  if (input.workspaceRoot === undefined) {
    return { status: "refused", reason: "upload-unavailable" };
  }
  const resolved = await resolveBrowserUploadFiles(input.workspaceRoot, input.files);
  if (resolved.status === "refused") return resolved;
  const staging = await mkdtemp(join(tmpdir(), "octant-browser-upload-"));
  const release = () => rm(staging, { recursive: true, force: true });
  try {
    const paths: string[] = [];
    for (const [index, file] of resolved.files.entries()) {
      // A folder of its own per file keeps each file's name, which is what the
      // page sees, even when two files share one.
      const folder = join(staging, String(index));
      await mkdir(folder, { mode: 0o700 });
      const copy = join(folder, file.name);
      if (!(await copyCheckedFile(file, copy))) {
        await release();
        return { status: "refused", reason: "upload-changed" };
      }
      paths.push(copy);
    }
    const outcome = await input.ask(resolved.files);
    if (outcome !== "approved") {
      await release();
      return { status: "refused", reason: `browser-upload-${outcome}` };
    }
    return { status: "admitted", paths, release };
  } catch (error) {
    await release();
    throw error;
  }
}

/** Copy one checked file, refusing it if it is no longer the file that was checked. */
async function copyCheckedFile(file: BrowserUploadFile, copy: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.dev !== file.device ||
      stats.ino !== file.inode ||
      stats.size !== file.sizeBytes
    ) {
      return false;
    }
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(copy, { mode: 0o600 }),
    );
    return true;
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
