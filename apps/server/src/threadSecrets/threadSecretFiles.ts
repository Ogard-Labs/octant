import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The folder of every thread's secrets, in the runtime or the data directory. */
export const THREAD_SECRETS_FOLDER = "thread-secrets";

/** A written secret that no path names yet. */
export interface PreparedThreadSecretFile {
  readonly path: string;
  /** Puts the file in place, keeping an earlier one aside until the grant is settled. */
  readonly commit: () => void;
  /** Ends what is kept aside. */
  readonly settle: () => void;
  /** Takes the file back, in place or not, and restores the earlier one. */
  readonly discard: () => void;
}

export interface ThreadSecretFiles {
  readonly prepare: (threadId: string, name: string, value: string) => PreparedThreadSecretFile;
  /** Throws when the file is still there. */
  readonly remove: (threadId: string, name: string) => void;
  /**
   * Removes every thread's files. Run as the host starts and stops: no file
   * outlives it. The empty folder stays, because a Linux sandbox can only
   * cover a folder that exists when it starts.
   */
  readonly sweep: () => void;
}

const THREAD = /^[A-Za-z0-9-]{1,128}$/u;
const NAME = /^[A-Z][A-Z0-9_]{0,112}$/u;

/**
 * Owner-only files under one folder per thread.
 *
 * POSIX modes make a folder and its files the owner's. Windows has no such
 * modes: `root` there is inside the host profile's data folder, whose
 * protected, inheritable access list admits its owner and the system alone, so
 * what is created in it is already private.
 *
 * Synchronous, so a grant's journal record and its file land with nothing in
 * between.
 */
export function createThreadSecretFiles(options: {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
}): ThreadSecretFiles {
  const windows = (options.platform ?? process.platform) === "win32";
  const folder = (path: string): void => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    // A link planted here would send the secret somewhere else.
    if (!stat.isDirectory()) throw new Error("A thread secret's folder is not a folder.");
    if (windows) return;
    if (process.getuid !== undefined && stat.uid !== process.getuid())
      throw new Error("A thread secret's folder belongs to someone else.");
    if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
  };
  /** The shared folder above this host's own is as plantable as it is. */
  const prepareRoot = (): void => {
    if (basename(dirname(options.root)) === THREAD_SECRETS_FOLDER) folder(dirname(options.root));
    folder(options.root);
  };
  const exists = (path: string): boolean =>
    lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  // A command that can write here can leave a folder where a file belongs.
  const clear = (path: string): void => rmSync(path, { recursive: true, force: true });
  const fileIn = (threadId: string, name: string): string => {
    if (!THREAD.test(threadId) || !NAME.test(name))
      throw new Error("A thread secret's name does not name a file.");
    return join(options.root, threadId, name);
  };
  return {
    prepare: (threadId, name, value) => {
      const path = fileIn(threadId, name);
      prepareRoot();
      folder(join(options.root, threadId));
      const partial = `${path}.partial`;
      const previous = `${path}.previous`;
      clear(partial);
      clear(previous);
      const descriptor = openSync(
        partial,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          // Not defined on Windows.
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const bytes = Buffer.from(value, "utf8");
        let written = 0;
        while (written < bytes.length) written += writeSync(descriptor, bytes, written);
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        clear(partial);
        throw error;
      }
      closeSync(descriptor);
      let committed = false;
      let kept = false;
      return {
        path,
        commit: () => {
          if (exists(path)) {
            renameSync(path, previous);
            kept = true;
          }
          renameSync(partial, path);
          committed = true;
        },
        settle: () => {
          if (kept) clear(previous);
        },
        discard: () => {
          clear(partial);
          if (committed) clear(path);
          if (kept) renameSync(previous, path);
          committed = false;
          kept = false;
        },
      };
    },
    remove: (threadId, name) => {
      const path = fileIn(threadId, name);
      const parent = lstatSync(dirname(path), { throwIfNoEntry: false });
      if (parent === undefined) return;
      if (!parent.isDirectory()) throw new Error("A thread secret's folder is not a folder.");
      for (const target of [path, `${path}.previous`, `${path}.partial`]) clear(target);
    },
    sweep: () => {
      prepareRoot();
      for (const entry of readdirSync(options.root)) clear(join(options.root, entry));
    },
  };
}
