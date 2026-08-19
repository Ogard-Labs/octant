import type { WorkFileIdentity, WorkFilesystemPort, WorkOpenWriteFile } from "./workFilesystemPort";

export interface WorkConfinedWriteRequest {
  readonly filesystem: WorkFilesystemPort;
  /** The path the confinement sequence resolved, not the one the caller was given. */
  readonly canonicalPath: string;
  /**
   * The object an earlier resolution approved. Required for an overwrite so
   * the write can prove it is still that object. Omitted for a create, which
   * mints a new object through an exclusive open.
   */
  readonly expected?: WorkFileIdentity;
  /** When true, a missing path is created exclusively instead of refused. */
  readonly allowCreate: boolean;
  readonly bytes: Uint8Array;
}

/**
 * Bytes written to the one object Work confinement approved, through a single
 * handle.
 *
 * A mutation resolves, then evaluates authority, then writes — and the whole
 * evaluation sits between the containment proof and the write. Handing the
 * name back to a path-based `writeFile` there would follow a symlink planted
 * in that window, or truncate a different object that now answers to the same
 * name. The handle refuses a symlinked final component; an overwrite must
 * still be the object resolution saw; a create is exclusive so a name that
 * appeared in the window cannot receive the bytes.
 *
 * `false` means refuse. Every caller maps it to its own surface's existing
 * failure vocabulary; none of them may fall back to an unconfined write.
 */
export async function writeConfinedWorkFile(request: WorkConfinedWriteRequest): Promise<boolean> {
  const existing = await openWrite(request.filesystem, request.canonicalPath, false);
  if (existing !== undefined) {
    return await writeOpened(existing, request.bytes, request.expected);
  }
  if (!request.allowCreate) return false;
  const created = await openWrite(request.filesystem, request.canonicalPath, true);
  if (created === undefined) return false;
  return await writeOpened(created, request.bytes);
}

async function openWrite(
  filesystem: WorkFilesystemPort,
  canonicalPath: string,
  exclusiveCreate: boolean,
): Promise<WorkOpenWriteFile | undefined> {
  try {
    return await filesystem.openWriteFile(canonicalPath, { exclusiveCreate });
  } catch {
    return undefined;
  }
}

async function writeOpened(
  file: WorkOpenWriteFile,
  bytes: Uint8Array,
  expected?: WorkFileIdentity,
): Promise<boolean> {
  try {
    const opened = await file.stat();
    if (!opened.isFile) return false;
    if (
      expected !== undefined &&
      (opened.device !== expected.device || opened.inode !== expected.inode)
    ) {
      return false;
    }
    await file.write(bytes);
    return true;
  } catch {
    return false;
  } finally {
    await file.close().catch(() => undefined);
  }
}
