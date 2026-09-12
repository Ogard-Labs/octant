import { readdir } from "node:fs/promises";
import {
  decodeWorkProjectStatus,
  type WorkProjectStatus,
} from "@octant/contracts/work-project-status";
import type { ProjectId, WorkOverviewItem } from "@octant/contracts";
import {
  DEFAULT_WORK_STATUS_STALE_AFTER_DAYS,
  isWorkStatusDate,
  isWorkStatusStale,
  parseWorkStatus,
} from "@octant/domain/work-project-status-policy";
import type { WorkProjectStatusFiles } from "./workProjectStatusFiles";

export interface WorkProjectStatusReaderOptions {
  readonly files: Pick<WorkProjectStatusFiles, "read">;
  readonly clock: () => string;
  readonly staleAfterDays?: number;
}

/**
 * A Work Project's status as the page and the board see it: read from the
 * folder on demand, parsed once, never journaled. Two files are read per
 * Project, which is cheap enough to do on every read; a projection of them
 * would only be a second copy of a file the person may edit at any time.
 */
export class WorkProjectStatusReader {
  readonly #files: Pick<WorkProjectStatusFiles, "read">;
  readonly #clock: () => string;
  readonly #staleAfterDays: number;

  constructor(options: WorkProjectStatusReaderOptions) {
    this.#files = options.files;
    this.#clock = options.clock;
    this.#staleAfterDays = options.staleAfterDays ?? DEFAULT_WORK_STATUS_STALE_AFTER_DAYS;
  }

  async read(projectId: ProjectId, canonicalRoot: string): Promise<WorkProjectStatus> {
    const today = this.#clock().slice(0, 10);
    if (!isWorkStatusDate(today)) throw new Error("Host clock did not produce a calendar date.");
    const snapshot = await this.#files.read(canonicalRoot);
    if (snapshot.status === undefined) {
      return decodeWorkProjectStatus({
        projectId,
        hasAgentsFile: snapshot.agents !== undefined,
        hasStatusFile: false,
        stale: true,
        followUps: [],
        deadlines: [],
      });
    }
    const parsed = parseWorkStatus(snapshot.status.text, today);
    return decodeWorkProjectStatus({
      projectId,
      hasAgentsFile: snapshot.agents !== undefined,
      hasStatusFile: true,
      ...(parsed.lastUpdatedOn === undefined ? {} : { lastUpdatedOn: parsed.lastUpdatedOn }),
      modifiedAt: snapshot.status.modifiedAt,
      stale: isWorkStatusStale(parsed, today, this.#staleAfterDays),
      ...(parsed.currentStatus === undefined ? {} : { currentStatus: parsed.currentStatus }),
      followUps: parsed.followUps,
      deadlines: parsed.deadlines,
    });
  }

  /** True when any dated line has passed or is due within days. */
  async hasDueItems(projectId: ProjectId, canonicalRoot: string): Promise<boolean> {
    try {
      const status = await this.read(projectId, canonicalRoot);
      return [...status.deadlines, ...status.followUps].some((item) => item.state !== "upcoming");
    } catch {
      return false;
    }
  }
}

const MAX_FOLDER_ITEMS = 64;

/**
 * The top level of a Work folder as overview items: names and whether each is
 * a folder. Hidden entries are skipped, the same names the listing tool hides,
 * and nothing is read beyond the directory entries themselves.
 */
export async function listWorkFolderTopLevel(
  canonicalRoot: string,
): Promise<ReadonlyArray<WorkOverviewItem>> {
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith(".") && (entry.isFile() || entry.isDirectory()))
    .sort((left, right) =>
      left.isDirectory() === right.isDirectory()
        ? left.name.localeCompare(right.name)
        : left.isDirectory()
          ? -1
          : 1,
    )
    .slice(0, MAX_FOLDER_ITEMS)
    .map((entry) => ({
      id: `folder:${entry.name}`.slice(0, 128),
      label: entry.name.slice(0, 512),
      detail: entry.isDirectory() ? "Folder" : "File",
    }));
}
