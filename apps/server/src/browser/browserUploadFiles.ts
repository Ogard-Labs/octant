import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { MAX_BROWSER_UPLOAD_FILE_BYTES } from "@octant/contracts";

/** One file an upload would send, as the person is asked about it. */
export interface BrowserUploadFile {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
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
    files.push({ path: candidate, name: basename(candidate), sizeBytes: stats.size });
  }
  return { status: "resolved", files };
}

/**
 * Resolve an upload's files and ask the person about exactly those, each time.
 * An upload is never remembered: the answer covers these files to this origin
 * once. Returns the paths a runtime may read, or why the upload stops.
 */
export async function admitBrowserUpload(input: {
  readonly workspaceRoot: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly ask: (
    files: ReadonlyArray<BrowserUploadFile>,
  ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
}): Promise<
  | { readonly status: "admitted"; readonly paths: ReadonlyArray<string> }
  | { readonly status: "refused"; readonly reason: string }
> {
  if (input.workspaceRoot === undefined) {
    return { status: "refused", reason: "upload-unavailable" };
  }
  const resolved = await resolveBrowserUploadFiles(input.workspaceRoot, input.files);
  if (resolved.status === "refused") return resolved;
  const outcome = await input.ask(resolved.files);
  if (outcome !== "approved") return { status: "refused", reason: `browser-upload-${outcome}` };
  return { status: "admitted", paths: resolved.files.map((file) => file.path) };
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
