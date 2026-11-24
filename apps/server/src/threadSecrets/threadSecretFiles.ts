import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** A written secret that no path names yet. */
export interface PreparedThreadSecretFile {
  readonly path: string;
  /** Puts the file in place, replacing an earlier one whole. */
  readonly commit: () => void;
  readonly discard: () => void;
}

export interface ThreadSecretFiles {
  readonly prepare: (threadId: string, name: string, value: string) => PreparedThreadSecretFile;
  /** Throws when the file is still there. */
  readonly remove: (threadId: string, name: string) => void;
  /** Removes every thread's files. Run as the host starts and stops: no file outlives it. */
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
  const fileIn = (threadId: string, name: string): string => {
    if (!THREAD.test(threadId) || !NAME.test(name))
      throw new Error("A thread secret's name does not name a file.");
    return join(options.root, threadId, name);
  };
  return {
    prepare: (threadId, name, value) => {
      const path = fileIn(threadId, name);
      folder(options.root);
      folder(join(options.root, threadId));
      const partial = `${path}.partial`;
      const discard = () => rmSync(partial, { force: true });
      discard();
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
        discard();
        throw error;
      }
      closeSync(descriptor);
      return { path, commit: () => renameSync(partial, path), discard };
    },
    remove: (threadId, name) => rmSync(fileIn(threadId, name), { force: true }),
    sweep: () => rmSync(options.root, { recursive: true, force: true }),
  };
}
