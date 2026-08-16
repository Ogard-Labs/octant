import type { WorkFileIdentity, WorkFilesystemPort, WorkOpenFile } from "./workFilesystemPort";

export interface WorkConfinedReadRequest {
  readonly filesystem: WorkFilesystemPort;
  /** The path the confinement sequence resolved, not the one the caller was given. */
  readonly canonicalPath: string;
  /** The object confinement resolved, so the read can prove it read that object. */
  readonly expected: WorkFileIdentity;
  readonly maximumBytes: number;
}

/**
 * The bytes of the one object Work confinement approved, read from a single
 * handle.
 *
 * Confinement proves a fact about a path, and a path can be made to mean
 * something else the moment after it is proved — in the mutation service the
 * whole authority evaluation sits in that window. So the path is opened once
 * and never resolved again: the handle refuses a symlinked final component, and
 * every fact that decides whether to read — regular file, same object, within
 * the ceiling — comes from that handle, as do the bytes. The read is capped at
 * the length the handle reported and must return exactly that, so an object
 * that grows after it was measured is refused rather than read.
 *
 * The device and inode equality is what closes the window: `O_NOFOLLOW` guards
 * only the final component, so the ancestor directories are still the
 * confinement sequence's `realpath` to check. That is why this is only ever
 * called on a path that sequence already resolved, with the identity it saw.
 *
 * `undefined` means refuse. Every caller maps it to its own surface's existing
 * failure vocabulary; none of them may fall back to a second read, truncate, or
 * trust a partial result.
 */
export async function readConfinedWorkFile(
  request: WorkConfinedReadRequest,
): Promise<Uint8Array | undefined> {
  let file: WorkOpenFile;
  try {
    file = await request.filesystem.openFile(request.canonicalPath);
  } catch {
    return undefined;
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile) return undefined;
    if (opened.device !== request.expected.device || opened.inode !== request.expected.inode) {
      return undefined;
    }
    if (opened.size > request.maximumBytes) return undefined;
    const bytes = await file.read(opened.size + 1);
    if (bytes.byteLength !== opened.size) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    await file.close().catch(() => undefined);
  }
}
