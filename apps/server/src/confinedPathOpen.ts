import { constants, open, readlink, type FileHandle } from "node:fs/promises";

const darwinNoFollowAny = 0x20000000;

/**
 * Opens a path a confinement sequence already canonicalized, so that the open
 * handle provably reached the object at that path and not one beyond a link.
 *
 * Every confined Code and Work read resolves a path several times: `realpath`
 * for containment, `stat` for identity, then `open`. Each resolves the
 * ancestors afresh, and `O_NOFOLLOW` guards only the final component. An agent
 * that can write the root can flip an ancestor directory between a real
 * directory and a link to a host folder, so `realpath` sees the root while the
 * `stat` and the `open` both reach the host file and the device/inode equality
 * passes. A rename loop won that race in roughly one attempt in fifty to one
 * in a hundred against every Code and Work read and listing surface. Only the
 * open itself can say which path it took:
 *
 * - Linux names the handle's location at `/proc/self/fd/N`; it must equal the
 *   canonical path.
 * - macOS cannot name it from Node or Bun, but `O_NOFOLLOW_ANY` (fcntl.h,
 *   macOS 11+, so every Apple Silicon host) makes the kernel refuse a link in
 *   any component during the open itself. A canonical path holds no links, so
 *   the object opened is the one at that path.
 * - Elsewhere there is no such guarantee and the open refuses.
 *
 * A refusal is thrown, as a failed open already is; every caller maps a failed
 * open to its own surface's refusal.
 */
export async function openConfinedPath(
  canonicalPath: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  if (process.platform === "darwin") {
    // O_NOFOLLOW_ANY subsumes O_NOFOLLOW, and macOS refuses the pair with
    // EINVAL, so it replaces the final-component flag rather than adding to it.
    return await open(canonicalPath, flags | darwinNoFollowAny, mode);
  }
  if (process.platform !== "linux") {
    throw new Error("this platform cannot prove where an open handle landed");
  }
  const handle = await open(canonicalPath, flags | constants.O_NOFOLLOW, mode);
  let location: string;
  try {
    location = await readlink(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  if (location !== canonicalPath) {
    await handle.close().catch(() => undefined);
    throw new Error("the opened object is not at the confined path");
  }
  return handle;
}

/**
 * The path `opendir` should enumerate so it lists the directory `handle` holds.
 *
 * Node cannot enumerate from a descriptor, and `opendir(path)` resolves the path
 * once more. On Linux `/proc/self/fd/N` resolves to the held object itself, so
 * the names come from the directory the handle proved. macOS has no such path
 * (`/dev/fd/N` names a duplicated descriptor whose behaviour as a directory is
 * unverified), so there the enumeration still resolves the canonical path, and
 * every name a caller acts on must be re-resolved through confinement.
 */
export function confinedEnumerationPath(handle: FileHandle, canonicalPath: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : canonicalPath;
}
