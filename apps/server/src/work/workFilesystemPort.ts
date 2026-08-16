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
  unlink,
  rename,
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
 */
export interface WorkFilesystemPort {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<WorkFileStat>;
  stat(path: string): Promise<WorkFileStat>;
  readlink(path: string): Promise<string>;
  openFile(path: string): Promise<WorkOpenFile>;
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
