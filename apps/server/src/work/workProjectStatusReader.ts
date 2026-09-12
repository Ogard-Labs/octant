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
import type { WorkStatusDatedItem } from "@octant/contracts/work-project-status";
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
    return (await this.dueReminder(projectId, canonicalRoot)) !== undefined;
  }

  /**
   * The single most urgent dated line for a reminder: what is already overdue
   * outranks what is only near, and within a state the earlier date wins. A
   * folder that cannot be read answers undefined, the same closed door as a
   * Project with nothing due.
   */
  async dueReminder(
    projectId: ProjectId,
    canonicalRoot: string,
  ): Promise<WorkStatusDatedItem | undefined> {
    try {
      const status = await this.read(projectId, canonicalRoot);
      return [...status.deadlines, ...status.followUps]
        .filter((item) => item.state !== "upcoming")
        .sort(
          (left, right) =>
            DUE_STATE_RANK[left.state] - DUE_STATE_RANK[right.state] ||
            left.date.localeCompare(right.date),
        )
        .at(0);
    } catch {
      return undefined;
    }
  }
}

const DUE_STATE_RANK: Readonly<Record<WorkStatusDatedItem["state"], number>> = {
  overdue: 0,
  "due-soon": 1,
  upcoming: 2,
};

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
