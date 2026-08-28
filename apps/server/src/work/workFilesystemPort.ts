import {
  constants,
  realpath as nodeRealpath,
  lstat,
  stat,
  open,
  readlink,
  readFile,
  writeFile,
  mkdir,
  rmdir,
  unlink,
  rename,
  type FileHandle,
} from "node:fs/promises";

/**
 * Filesystem metadata for a Work-confined path. The port exposes only the
 * fields the resolution and mutation services need; raw device/inode data
 * never reaches the renderer through this surface.
 *
 * Device and inode are the host identity of the object the confinement sequence
 * resolved. They exist so a later read can prove it is reading *that* object
 * rather than whatever now answers to the same name.
 */
export interface WorkFileStat {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
}

/** The host identity of one filesystem object, as resolved confinement saw it. */
export interface WorkFileIdentity {
  readonly device: string;
  readonly inode: string;
}

/**
 * Facts an opened file reports about itself, read from the open handle rather
 * than from the name it was opened under.
 */
export interface WorkOpenFileStat {
  readonly isFile: boolean;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
}

/**
 * One open file, held so that every later fact and byte comes from this handle.
 *
 * A handle is bound to the object that was open at the moment it was created,
 * so replacing the name it was opened under cannot change what it reports or
 * what it reads. That is the whole point: the path is resolved once.
 */
export interface WorkOpenFile {
  stat(): Promise<WorkOpenFileStat>;
  /** At most `maximumBytes` bytes, so a file that grows cannot exceed a bound. */
  read(maximumBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * One open file opened for a confined write, held so every later fact and
 * byte goes to this handle.
 *
 * A handle is bound to the object that was open at the moment it was created,
 * so replacing the name it was opened under cannot redirect the write.
 */
export interface WorkOpenWriteFile {
  stat(): Promise<WorkOpenFileStat>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * One open directory, held so child creates stay bound to this object.
 *
 * `O_NOFOLLOW` on a path-based create only refuses a symlinked final name. A
 * parent swapped for an escaping symlink after resolveForCreate would still be
 * followed. Child opens go through this handle so that swap cannot redirect
 * the write.
 */
export interface WorkOpenDirectory {
  stat(): Promise<{
    readonly isDirectory: boolean;
    readonly device: string;
    readonly inode: string;
  }>;
  openDirectory(name: string): Promise<WorkOpenDirectory>;
  mkdir(name: string): Promise<void>;
  openWriteFile(
    name: string,
    options: { readonly exclusiveCreate: boolean },
  ): Promise<WorkOpenWriteFile>;
  close(): Promise<void>;
}

/**
 * Testable filesystem port for Work resolution and mutation. The live
 * implementation delegates to `node:fs/promises`; tests supply an in-memory
 * implementation so confinement, symlink, moved-root, and cancellation paths
 * exercise the real resolution logic without touching the host filesystem.
 *
 * `openFile` is the only way a confined Work read may obtain bytes: it
 * refuses to follow a symlinked final component, and the handle it returns
 * answers every later question about the object, so a path swapped after
 * confinement resolved it is an error rather than an escape. `readFile` remains
 * for reads that are not confinement decisions and must not be used to fetch
 * bytes a containment check has already approved — see `readConfinedWorkFile`.
 *
 * `openWriteFile` is the only way a confined Work write may emit bytes. A
 * path-based `writeFile` follows a final symlink the way the host's does and
 * must not be used after a containment proof — see `writeConfinedWorkFile`.
 */
export interface WorkFilesystemPort {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<WorkFileStat>;
  stat(path: string): Promise<WorkFileStat>;
  readlink(path: string): Promise<string>;
  openFile(path: string): Promise<WorkOpenFile>;
  openWriteFile(
    path: string,
    options: { readonly exclusiveCreate: boolean },
  ): Promise<WorkOpenWriteFile>;
  openDirectory(path: string): Promise<WorkOpenDirectory>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string, options: { readonly recursive: true }): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

type LiveStat = Awaited<ReturnType<typeof stat>> & { readonly dev: bigint; readonly ino: bigint };

// Identity is read as bigint so a large inode keeps every digit; the comparison
// that uses it is an equality check on the decimal text.
const toStat = (info: LiveStat): WorkFileStat => ({
  isDirectory: info.isDirectory(),
  isFile: info.isFile(),
  isSymbolicLink: info.isSymbolicLink(),
  size: Number(info.size),
  device: String(info.dev),
  inode: String(info.ino),
});

export const liveWorkFilesystem: WorkFilesystemPort = {
  realpath: nodeRealpath,
  lstat: async (path) => toStat(await lstat(path, { bigint: true })),
  stat: async (path) => toStat(await stat(path, { bigint: true })),
  readlink,
  openFile: async (path) => {
    // O_NOFOLLOW refuses a final component that is a symlink. It says nothing
    // about the ancestors, which is why the caller must still have run the
    // containment sequence — this only closes the window after it.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      stat: async () => {
        const info = await handle.stat({ bigint: true });
        return {
          isFile: info.isFile(),
          size: Number(info.size),
          device: String(info.dev),
          inode: String(info.ino),
        };
      },
      read: async (maximumBytes) => {
        const buffer = Buffer.alloc(Math.max(0, maximumBytes));
        let filled = 0;
        while (filled < buffer.byteLength) {
          const { bytesRead } = await handle.read(
            buffer,
            filled,
            buffer.byteLength - filled,
            filled,
          );
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return new Uint8Array(buffer.subarray(0, filled));
      },
      close: () => handle.close(),
    };
  },
  openWriteFile: async (path, options) => openLiveWriteFile(path, options),
  openDirectory: async (path) =>
    liveDirectory(
      await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      path,
    ),
  readFile: async (path) => await readFile(path),
  writeFile: async (path, bytes) => {
    await writeFile(path, bytes);
  },
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  unlink,
  rename,
};

function confinedEntryName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new Error(`invalid directory entry ${name}`);
  }
  return name;
}

// macOS has no fd-relative path surface: /dev/fd/N names the duplicated
// descriptor itself, so appending a child (`/dev/fd/N/name`) fails ENOENT
// (observed on Darwin: openDirectory, mkdir, and exclusive create all refuse).
// Children are opened by the directory's tracked canonical path instead, with
// O_NOFOLLOW_ANY (fcntl.h, macOS 11+) refusing a symlink in any component
// atomically in-kernel. Resolution hands this port canonical paths, so the
// flag only fires on a component swapped in after the containment proof — the
// escape the Linux fd-relative walk refuses by construction. The two walks
// diverge only on a raced parent rename: the Linux write keeps landing on the
// held object, while macOS refuses and the caller reports the write as
// refused.
const darwinNoFollowAny = 0x20000000;

// O_NOFOLLOW_ANY subsumes O_NOFOLLOW, and macOS refuses the pair with EINVAL
// (observed), so the darwin child guard replaces the final-component flag
// rather than adding to it.
const childNoFollow = process.platform === "linux" ? constants.O_NOFOLLOW : darwinNoFollowAny;

function childOpenPath(handle: FileHandle, directoryPath: string, name: string): string {
  const entry = confinedEntryName(name);
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}/${entry}`;
  return `${directoryPath}/${entry}`;
}

function liveDirectory(handle: FileHandle, directoryPath: string): WorkOpenDirectory {
  return {
    stat: async () => {
      const info = await handle.stat({ bigint: true });
      return {
        isDirectory: info.isDirectory(),
        device: String(info.dev),
        inode: String(info.ino),
      };
    },
    openDirectory: async (name) =>
      liveDirectory(
        await open(
          childOpenPath(handle, directoryPath, name),
          constants.O_RDONLY | constants.O_DIRECTORY | childNoFollow,
        ),
        `${directoryPath}/${confinedEntryName(name)}`,
      ),
    mkdir: async (name) => {
      const path = childOpenPath(handle, directoryPath, name);
      if (process.platform === "linux") {
        await mkdir(path);
        return;
      }
      // mkdir(2) accepts no O_NOFOLLOW_ANY and the runtime exposes no mkdirat,
      // so a symlink swapped over the tracked path could route this create
      // outside the proven parent — a mutation confinement must not emit even
      // when empty. Refuse while the path no longer names the held object,
      // and revert the create when the guarded re-open cannot prove where it
      // landed. The remaining window is the check-to-mkdir gap; nothing can
      // be written through it because every byte-carrying open stays guarded.
      const named = await lstat(directoryPath, { bigint: true });
      const held = await handle.stat({ bigint: true });
      if (!named.isDirectory() || named.dev !== held.dev || named.ino !== held.ino) {
        throw new Error(`directory entry ${name} cannot be created under a moved parent`);
      }
      await mkdir(path);
      let created: FileHandle;
      try {
        created = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | childNoFollow);
      } catch (error) {
        await rmdir(path).catch(() => undefined);
        throw error;
      }
      await created.close();
    },
    openWriteFile: async (name, options) =>
      openLiveWriteFile(childOpenPath(handle, directoryPath, name), options, childNoFollow),
    close: () => handle.close(),
  };
}

async function openLiveWriteFile(
  path: string,
  options: { readonly exclusiveCreate: boolean },
  noFollow: number = constants.O_NOFOLLOW,
): Promise<WorkOpenWriteFile> {
  const flags = options.exclusiveCreate
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow
    : constants.O_WRONLY | noFollow;
  const handle = await open(path, flags, 0o600);
  return {
    stat: async () => {
      const info = await handle.stat({ bigint: true });
      return {
        isFile: info.isFile(),
        size: Number(info.size),
        device: String(info.dev),
        inode: String(info.ino),
      };
    },
    write: async (bytes) => {
      await handle.truncate(0);
      const buffer = Buffer.from(bytes);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesWritten } = await handle.write(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        );
        if (bytesWritten === 0) throw new Error("short write");
        offset += bytesWritten;
      }
    },
    close: () => handle.close(),
  };
}
