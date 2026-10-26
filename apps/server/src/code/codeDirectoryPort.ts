import { constants, lstat, opendir, readlink, realpath, stat } from "node:fs/promises";
import { confinedEnumerationPath, openConfinedPath } from "../confinedPathOpen";

/**
 * Filesystem facts the confined Code surfaces need.
 *
 * Device and inode are the host identity of the object the confinement sequence
 * resolved. They exist so a later read can prove it is reading *that* object
 * rather than whatever now answers to the same name; no surface reports them to
 * a renderer, which needs no host identity numbers to render a tree.
 */
export interface CodeDirectoryStat {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
  readonly mode?: number;
}

/** One raw directory child, before any confinement or classification. */
export interface CodeDirectoryChild {
  readonly name: string;
}

/**
 * The path facts every confined Code read needs before it may follow a path:
 * enough to run the containment sequence in `codePathConfinement`, and nothing
 * more. Both the listing port and the test-source port build on it, so the
 * confinement sequence has exactly one implementation.
 */
export interface CodePathPort {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<CodeDirectoryStat>;
  stat(path: string): Promise<CodeDirectoryStat>;
  readlink(path: string): Promise<string>;
}

/** Facts an opened directory reports about itself, read from the handle. */
export interface CodeOpenDirectoryStat {
  readonly isDirectory: boolean;
  readonly device: string;
  readonly inode: string;
}

/**
 * One open directory, held so that every name comes from this enumeration.
 *
 * The stream is bound to the object that was open at the moment it was created,
 * so replacing the name it was opened under cannot change which entries it
 * yields. `read` is bounded because a directory has no size to check first: a
 * host directory raced in, or an in-repo directory with a million files, must
 * cost the caller its budget and not the whole listing.
 */
export interface CodeOpenDirectory {
  stat(): Promise<CodeOpenDirectoryStat>;
  /** At most `maximumEntries` names, taken from where the last read stopped. */
  read(maximumEntries: number): Promise<ReadonlyArray<CodeDirectoryChild>>;
  close(): Promise<void>;
}

/**
 * Testable filesystem port for confined Code file listing.
 *
 * The live implementation delegates to `node:fs/promises`; tests supply an
 * in-memory implementation so the symlink-escape, moved-root, swapped-directory
 * and budget paths exercise the real confinement logic without touching the
 * host filesystem. Mirrors `WorkFilesystemPort`, which proves the same
 * discipline for Work.
 *
 * `openDirectory` is only ever called on a path the confinement sequence
 * already proved is a directory inside the bound checkout, and it refuses to
 * follow a symlink in the final component, so a link swapped in after that
 * proof is an error rather than an escape.
 */
export interface CodeDirectoryPort extends CodePathPort {
  openDirectory(path: string): Promise<CodeOpenDirectory>;
}

/**
 * Facts an opened file reports about itself, read from the open handle rather
 * than from the name it was opened under.
 */
export interface CodeOpenFileStat {
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
export interface CodeOpenFile {
  stat(): Promise<CodeOpenFileStat>;
  /** At most `maximumBytes` bytes, so a file that grows cannot exceed a bound. */
  read(maximumBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Testable filesystem port for reading the two files repository-test discovery
 * is allowed to read.
 *
 * `openFile` is only ever called on a path the confinement sequence already
 * proved is a regular file inside the bound checkout, and it refuses to follow a
 * symlink in the final component, so a link swapped in after that proof is an
 * error rather than an escape.
 */
export interface CodeTestSourcePort extends CodePathPort {
  openFile(path: string): Promise<CodeOpenFile>;
}

type LiveStat = Awaited<ReturnType<typeof stat>> & { readonly dev: bigint; readonly ino: bigint };

// Identity is read as bigint so a large inode keeps every digit; the comparison
// that uses it is an equality check on the decimal text.
const toStat = (info: LiveStat): CodeDirectoryStat => ({
  isDirectory: info.isDirectory(),
  isFile: info.isFile(),
  isSymbolicLink: info.isSymbolicLink(),
  size: Number(info.size),
  device: String(info.dev),
  inode: String(info.ino),
  mode: Number(info.mode),
});

const livePathPort: CodePathPort = {
  realpath,
  lstat: async (path) => toStat(await lstat(path, { bigint: true })),
  stat: async (path) => toStat(await stat(path, { bigint: true })),
  readlink,
};

export const liveCodeDirectoryPort: CodeDirectoryPort = {
  ...livePathPort,
  openDirectory: async (path) => {
    // The handle must land on the directory containment resolved, proved by
    // the open itself, so an ancestor swapped for a link after containment is
    // refused here rather than matched by identity. O_DIRECTORY refuses
    // anything that is not a directory, and holding the handle open for the
    // enumeration pins the inode, so the identity cannot be recycled underneath
    // the caller's comparison.
    const handle = await openConfinedPath(path, constants.O_RDONLY | constants.O_DIRECTORY);
    let stream: Awaited<ReturnType<typeof opendir>>;
    try {
      // `opendir` yields entries in bounded batches of its own, so nothing here
      // materializes a directory the caller never asked for.
      stream = await opendir(confinedEnumerationPath(handle, path));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return {
      stat: async () => {
        const info = await handle.stat({ bigint: true });
        return {
          isDirectory: info.isDirectory(),
          device: String(info.dev),
          inode: String(info.ino),
        };
      },
      read: async (maximumEntries) => {
        const names: CodeDirectoryChild[] = [];
        while (names.length < maximumEntries) {
          const entry = await stream.read();
          if (entry === null) break;
          names.push({ name: entry.name });
        }
        return names;
      },
      close: async () => {
        await stream.close().catch(() => undefined);
        await handle.close();
      },
    };
  },
};

export const liveCodeTestSourcePort: CodeTestSourcePort = {
  ...livePathPort,
  openFile: async (path) => {
    // The caller must still have run the containment sequence; the open then
    // proves it landed on the path that sequence resolved, so an ancestor
    // swapped for a link in between is refused. O_NONBLOCK keeps a FIFO swapped
    // in after that sequence from holding the open until a writer appears; the
    // caller's isFile check on the handle then refuses it.
    const handle = await openConfinedPath(path, constants.O_RDONLY | constants.O_NONBLOCK);
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
};
