import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The folder destination's one door to the filesystem.
 *
 * A write lands in the folder the person chose and nowhere else: the name is
 * built by policy, the parent is proved to be the chosen folder, and the bytes
 * are written to a temporary file and renamed into place so a reader never sees
 * a half-written export. A crash leaves a dotted temporary file, never a
 * truncated document under the real name.
 */
export interface CanvasExportFilePort {
  /** Write one named file into the folder, atomically. */
  readonly writeAtomically: (
    folder: string,
    fileName: string,
    contents: string,
    tempId: string,
  ) => Promise<void>;
  readonly existsIn: (folder: string, fileName: string) => boolean;
  /**
   * Whether the folder exists and can be written, measured synchronously.
   *
   * The offer list is built synchronously — a destination's status cannot wait
   * on I/O — so this is a plain stat and access check under the folder the
   * person already chose.
   */
  readonly isWritableFolder: (folder: string) => boolean;
}

export function createCanvasExportFilePort(): CanvasExportFilePort {
  return {
    async writeAtomically(folder, fileName, contents, tempId) {
      if (!isAbsolute(folder)) throw new Error("An export folder must be an absolute path.");
      const root = resolve(folder);
      const target = resolve(root, fileName);
      // The policy builds a name with no separator in it; this is the second
      // check, because a port that trusted its caller is how one missed decode
      // becomes a write somewhere else on the disk.
      if (dirname(target) !== root) {
        throw new Error("Refusing to write outside the export folder.");
      }
      await mkdir(root, { recursive: true });
      const temporary = join(root, `.${fileName}.${tempId}.tmp`);
      await writeFile(temporary, contents, "utf8");
      await rename(temporary, target);
    },

    existsIn(folder, fileName) {
      return existsSync(join(folder, fileName));
    },

    isWritableFolder(folder) {
      if (!isAbsolute(folder)) return false;
      try {
        if (!statSync(folder).isDirectory()) return false;
        accessSync(folder, constants.W_OK | constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
