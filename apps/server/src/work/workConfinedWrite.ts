import type {
  WorkFileIdentity,
  WorkFilesystemPort,
  WorkOpenDirectory,
  WorkOpenWriteFile,
} from "./workFilesystemPort";

export interface WorkConfinedCreateParent {
  readonly absolutePath: string;
  readonly identity: WorkFileIdentity;
  readonly remaining: ReadonlyArray<string>;
}

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
  /**
   * The contained parent `resolveForCreate` proved, plus the names still to
   * create under it. Required for a create so the write cannot reopen a path
   * whose ancestor was swapped for an escaping symlink.
   */
  readonly parent?: WorkConfinedCreateParent;
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
  if (request.allowCreate && request.parent !== undefined) {
    return await writeCreatedUnderParent(request.filesystem, request.parent, request.bytes);
  }
  const existing = await openWrite(request.filesystem, request.canonicalPath, false);
  if (existing !== undefined) {
    return await writeOpened(existing, request.bytes, request.expected);
  }
  if (!request.allowCreate) return false;
  const created = await openWrite(request.filesystem, request.canonicalPath, true);
  if (created === undefined) return false;
  return await writeOpened(created, request.bytes);
}

async function writeCreatedUnderParent(
  filesystem: WorkFilesystemPort,
  parent: WorkConfinedCreateParent,
  bytes: Uint8Array,
): Promise<boolean> {
  const leaf = parent.remaining[parent.remaining.length - 1];
  if (leaf === undefined) return false;
  let directory: WorkOpenDirectory;
  try {
    directory = await filesystem.openDirectory(parent.absolutePath);
  } catch {
    return false;
  }
  try {
    const opened = await directory.stat();
    if (
      !opened.isDirectory ||
      opened.device !== parent.identity.device ||
      opened.inode !== parent.identity.inode
    ) {
      return false;
    }
    for (const segment of parent.remaining.slice(0, -1)) {
      const next = await openOrCreateChildDirectory(directory, segment);
      if (next === undefined) return false;
      await directory.close().catch(() => undefined);
      directory = next;
    }
    const created = await directory.openWriteFile(leaf, { exclusiveCreate: true });
    return await writeOpened(created, bytes);
  } catch {
    return false;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function openOrCreateChildDirectory(
  directory: WorkOpenDirectory,
  name: string,
): Promise<WorkOpenDirectory | undefined> {
  try {
    return await directory.openDirectory(name);
  } catch {
    try {
      await directory.mkdir(name);
      return await directory.openDirectory(name);
    } catch {
      return undefined;
    }
  }
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
