import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopArtifactRefusal } from "@octant/contracts";
import { decideDesktopArtifactPath } from "@octant/domain";

/**
 * Reads the one file a desktop transfer names out of a thread's checkout.
 *
 * This runs in the host process with the host's reach, on a path an agent
 * chose inside a directory an agent can write. So nothing is followed: every
 * component is `lstat`ed and a symlink anywhere refuses, the canonical path
 * must be the root joined with exactly those components, and the file is
 * opened without following a link and must be the object the walk saw, at the
 * walked path as the kernel names the open handle. Every fact that decides
 * whether to send it (regular file, same object, size) and the bytes
 * themselves come from that one handle. The read takes exactly the
 * size the handle reported, asks for one byte more, and checks the handle
 * again afterwards, so a file that grows, shrinks, or is rewritten during the
 * read is refused rather than sent half old and half new.
 */

/** The open file the read needs; a test can stand in for one that changes mid-read. */
export interface DesktopArtifactFile {
  readonly stat: () => Promise<Stats>;
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
  /** Where the open object lives now, as the kernel names it; undefined where the platform cannot say. */
  readonly location: () => Promise<string | undefined>;
}

export interface DesktopArtifactReadRequest {
  /** The thread's bound root: its Code checkout, or its Work Project root. */
  readonly root: string;
  /** The path as the caller gave it. */
  readonly path: string;
  readonly maximumBytes: number;
  readonly openFile?: (path: string, flags: number) => Promise<DesktopArtifactFile>;
}

export interface DesktopArtifact {
  /** Root-relative and `/`-separated, as journaled. */
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export type DesktopArtifactReadResult =
  | { readonly status: "read"; readonly artifact: DesktopArtifact; readonly bytes: Uint8Array }
  | DesktopArtifactRefusal;

const refused = (reason: DesktopArtifactRefusal["reason"]): DesktopArtifactRefusal => ({
  status: "refused",
  reason,
});

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** The handle's view of the file has not moved since `before`. */
function unchanged(before: Stats, after: Stats): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs
  );
}

/**
 * Each path check and the open resolve the path afresh, and `O_NOFOLLOW`
 * guards only the last component. An agent flipping an ancestor directory
 * between a real directory and a link to a host folder won that race about one
 * read in two hundred: the walk's last step and the open reached the host
 * file, and the checks between them saw the checkout. Only the open handle
 * itself can say where the file it reached lives. Linux names it under
 * `/proc/self/fd`; Node has no such query on macOS, so a read there refuses
 * `path-unverifiable`.
 */
export async function openDesktopArtifactFile(
  path: string,
  flags: number,
): Promise<DesktopArtifactFile> {
  const handle = await open(path, flags);
  return {
    stat: () => handle.stat(),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    close: () => handle.close(),
    location: async () =>
      process.platform === "linux" ? readlink(`/proc/self/fd/${handle.fd}`) : undefined,
  };
}

export async function readDesktopArtifact(
  request: DesktopArtifactReadRequest,
): Promise<DesktopArtifactReadResult> {
  const decided = decideDesktopArtifactPath(request.path);
  if (decided.kind === "refused") return refused(decided.reason);

  let root: string;
  try {
    root = await realpath(request.root);
  } catch {
    return refused("no-root");
  }
  let walked = root;
  let seen: Stats | undefined;
  for (const [index, segment] of decided.segments.entries()) {
    walked = join(walked, segment);
    let entry: Stats;
    try {
      entry = await lstat(walked);
    } catch (error) {
      const code = errorCode(error);
      return refused(code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "not-a-file");
    }
    if (entry.isSymbolicLink()) return refused("path-symlink");
    const last = index === decided.segments.length - 1;
    if (!last && !entry.isDirectory()) return refused("not-found");
    if (last) seen = entry;
  }
  if (seen === undefined || !seen.isFile()) return refused("not-a-file");
  if (seen.size > request.maximumBytes) return refused("too-large");
  // An ancestor swapped for a link after the walk would put the file outside
  // the root; the canonical path catches that before anything is opened.
  try {
    if ((await realpath(walked)) !== walked) return refused("path-escapes-root");
  } catch {
    return refused("changed-while-read");
  }

  const openFile = request.openFile ?? openDesktopArtifactFile;
  let file: DesktopArtifactFile;
  try {
    // Non-blocking, so a FIFO swapped in after the walk cannot hold the open.
    file = await openFile(walked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return refused(errorCode(error) === "ELOOP" ? "path-symlink" : "changed-while-read");
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== seen.dev || before.ino !== seen.ino) {
      return refused("changed-while-read");
    }
    const location = await file.location();
    if (location === undefined) return refused("path-unverifiable");
    if (location !== walked) return refused("changed-while-read");
    if (before.size > request.maximumBytes) return refused("too-large");
    const bytes = new Uint8Array(before.size);
    let filled = 0;
    while (filled < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, filled, bytes.byteLength - filled, filled);
      if (bytesRead === 0) return refused("changed-while-read");
      filled += bytesRead;
    }
    const beyond = await file.read(new Uint8Array(1), 0, 1, filled);
    if (beyond.bytesRead > 0) return refused("changed-while-read");
    if (!unchanged(before, await file.stat())) return refused("changed-while-read");
    return {
      status: "read",
      artifact: {
        path: decided.path,
        name: decided.name,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    };
  } catch {
    return refused("changed-while-read");
  } finally {
    await file.close().catch(() => undefined);
  }
}
