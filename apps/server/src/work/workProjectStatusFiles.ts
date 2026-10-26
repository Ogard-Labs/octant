import { constants, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { UtcTimestamp } from "@octant/contracts";
import {
  WORK_STATUS_FILE_NAME,
  appendWorkRecentChange,
  workStatusTemplate,
  type WorkRecentChange,
} from "@octant/domain/work-project-status-policy";
import type { WorkStatusDate } from "@octant/contracts/work-project-status";

/** Larger than this and the file is the person's document, not a brief. */
export const MAX_WORK_STATUS_FILE_BYTES = 65_536;

export interface WorkProjectFileText {
  readonly text: string;
  readonly modifiedAt: UtcTimestamp;
}

export interface WorkProjectStatusFilesystem {
  /** The path with every symlink resolved, the same check that marks a Project unavailable. */
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<{
    readonly isFile: boolean;
    readonly isSymbolicLink: boolean;
    readonly size: number;
    readonly mtimeMs: number;
  }>;
  readonly readFile: (path: string) => Promise<string>;
  /** Exclusive create; rejects when the name exists. */
  readonly createFile: (path: string, text: string) => Promise<void>;
  /** Overwrite in place without following a symlink at the final component. */
  readonly replaceFile: (path: string, text: string) => Promise<void>;
}

export const liveWorkProjectStatusFilesystem: WorkProjectStatusFilesystem = {
  realpath: (path) => realpath(path),
  lstat: async (path) => {
    const details = await lstat(path);
    return {
      isFile: details.isFile(),
      isSymbolicLink: details.isSymbolicLink(),
      size: details.size,
      mtimeMs: details.mtimeMs,
    };
  },
  readFile: async (path) => {
    // The name was checked with lstat, but it can be swapped afterwards. The
    // open neither follows a link nor waits on a FIFO, and the handle must
    // still be a regular file.
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error("The status name is not a file.");
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  },
  createFile: async (path, text) => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
  },
  replaceFile: async (path, text) => {
    // Without O_NONBLOCK a FIFO swapped in under the name holds the open until
    // a reader appears. With it, the open fails when there is no reader, and
    // otherwise the isFile check refuses the handle. Truncating only after that
    // check leaves nothing but a regular file emptied.
    const handle = await open(
      path,
      constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error("The status name is not a file.");
      await handle.truncate(0);
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
  },
};

/**
 * The `STATUS.md` at the top of a Work Project folder that opted into one.
 *
 * Only this one fixed name directly under the canonical root is ever touched,
 * and a name that is a symlink is treated as absent rather than followed: the
 * folder is the person's, and a link they planted must not turn "seed a
 * status file" into a write somewhere else. Reading is bounded so a status
 * that grew into a document is left to the person rather than poured into
 * every turn. Callers check the Project's setting before reaching here.
 *
 * The stored root is trusted only while it still resolves to itself. A bound
 * folder that was renamed and replaced by a symlink leaves the stored path
 * pointing somewhere else; the final-name check cannot see a link above it, so
 * every read and write first confirms the root is still canonical.
 */
export class WorkProjectStatusFiles {
  readonly #fs: WorkProjectStatusFilesystem;

  constructor(filesystem: WorkProjectStatusFilesystem = liveWorkProjectStatusFilesystem) {
    this.#fs = filesystem;
  }

  /** Create `STATUS.md` when it is missing; true when this call created it. */
  async seed(canonicalRoot: string, projectName: string, today: WorkStatusDate): Promise<boolean> {
    const path = await this.#statusPath(canonicalRoot);
    if (path === undefined || (await this.#regularFile(path)) !== "missing") return false;
    try {
      await this.#fs.createFile(path, workStatusTemplate(projectName, today));
      return true;
    } catch {
      // Someone else created it between the check and the write, or the
      // folder refuses writes. Either way the file is not ours to force.
      return false;
    }
  }

  async read(canonicalRoot: string): Promise<WorkProjectFileText | undefined> {
    const path = await this.#statusPath(canonicalRoot);
    return path === undefined ? undefined : this.#readText(path);
  }

  /**
   * Add a turn's changed files to `Recent changes`. Returns false when there
   * is no readable status file to append to; nothing is created here, since a
   * Project without the file has chosen not to have one.
   */
  async appendRecentChange(canonicalRoot: string, change: WorkRecentChange): Promise<boolean> {
    const path = await this.#statusPath(canonicalRoot);
    if (path === undefined) return false;
    const current = await this.#readText(path);
    if (current === undefined) return false;
    try {
      await this.#fs.replaceFile(path, appendWorkRecentChange(current.text, change));
      return true;
    } catch {
      return false;
    }
  }

  /** `STATUS.md` under the root, or undefined when the root no longer resolves to itself. */
  async #statusPath(canonicalRoot: string): Promise<string | undefined> {
    try {
      if ((await this.#fs.realpath(canonicalRoot)) !== canonicalRoot) return undefined;
    } catch {
      return undefined;
    }
    return join(canonicalRoot, WORK_STATUS_FILE_NAME);
  }

  /**
   * The name as a regular file, or why it is not one. `missing` is the only
   * answer that permits a create; a symlink or directory under the name is
   * "taken" so nothing is written there, and nothing is read through it.
   */
  async #regularFile(
    path: string,
  ): Promise<{ readonly size: number; readonly mtimeMs: number } | "missing" | "taken"> {
    try {
      const details = await this.#fs.lstat(path);
      if (details.isSymbolicLink || !details.isFile) return "taken";
      return { size: details.size, mtimeMs: details.mtimeMs };
    } catch {
      return "missing";
    }
  }

  async #readText(path: string): Promise<WorkProjectFileText | undefined> {
    const details = await this.#regularFile(path);
    if (typeof details === "string" || details.size > MAX_WORK_STATUS_FILE_BYTES) return undefined;
    try {
      return {
        text: await this.#fs.readFile(path),
        modifiedAt: new Date(details.mtimeMs).toISOString() as UtcTimestamp,
      };
    } catch {
      return undefined;
    }
  }
}
