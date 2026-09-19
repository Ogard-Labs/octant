import {
  DEFAULT_PROJECT_VIEW_FILTERS,
  type ProjectViewActivityPeriod,
  type ProjectViewActivityRange,
  type ProjectViewEnvironment,
  type ProjectViewFilters,
  type ProjectViewGrouping,
  type ProjectViewLifecycle,
  type ProjectViewSort,
} from "@octant/contracts/project-view";
import {
  SIDEBAR_THREAD_STATUS_ORDER,
  type SidebarThreadStatus,
} from "@octant/contracts/sidebar-thread-status";
import {
  compareSidebarProjectStatus,
  resolveSidebarThreadStatus,
  rollUpSidebarProjectStatus,
  type SidebarThreadStatusInput,
} from "./sidebarThreadStatusPolicy";

export type {
  ProjectViewActivityPeriod,
  ProjectViewActivityRange,
  ProjectViewEnvironment,
  ProjectViewFilters,
  ProjectViewGrouping,
  ProjectViewLifecycle,
  ProjectViewSort,
};

export { DEFAULT_PROJECT_VIEW_FILTERS };

const LIFECYCLES: ReadonlyArray<ProjectViewLifecycle> = ["active", "archived", "all"];
const GROUPINGS: ReadonlyArray<ProjectViewGrouping> = ["project", "environment", "status", "none"];
const SORTS: ReadonlyArray<ProjectViewSort> = ["recency", "alphabetical", "created", "status"];
const ACTIVITY_PERIODS: ReadonlyArray<ProjectViewActivityPeriod> = [
  "all",
  "today",
  "3-days",
  "7-days",
  "14-days",
  "30-days",
  "custom",
];

export interface ProjectViewProjectLike {
  readonly id: string;
  readonly name?: string;
  readonly lifecycle?: ProjectViewLifecycle | "active" | "archived";
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * What a saved view needs to know about one thread.
 *
 * The status facts are optional because most callers filter and sort on time
 * alone. A caller that omits them gets a thread that reports no status, which
 * a status filter treats as not matching and a status sort treats as quiet —
 * the same reading either way, rather than one that guesses.
 */
export interface ProjectViewThreadLike {
  readonly projectId?: string;
  readonly updatedAt?: string;
  readonly status?: Partial<SidebarThreadStatusInput>;
}

function threadStatusFacts(thread: ProjectViewThreadLike): SidebarThreadStatusInput {
  return {
    working: thread.status?.working ?? false,
    attention: thread.status?.attention ?? false,
    woke: thread.status?.woke ?? false,
    unread: thread.status?.unread ?? false,
  };
}

/**
 * Turns unknown saved filter JSON into a complete document. Malformed fields
 * fall back to conservative defaults so a corrupt lens cannot hide the saved
 * Project set or invent an activity window.
 */
export function normalizeProjectViewFilters(value: unknown): ProjectViewFilters {
  if (value === null || typeof value !== "object") return DEFAULT_PROJECT_VIEW_FILTERS;
  const record = value as {
    readonly lifecycle?: unknown;
    readonly environmentIds?: unknown;
    readonly environments?: unknown;
    readonly showEmptyProjects?: unknown;
    readonly grouping?: unknown;
    readonly sorting?: unknown;
    readonly activity?: unknown;
    readonly activityRange?: unknown;
    readonly statuses?: unknown;
  };
  const lifecycle = LIFECYCLES.find((candidate) => candidate === record.lifecycle);
  const grouping = GROUPINGS.find((candidate) => candidate === record.grouping);
  const sorting = SORTS.find((candidate) => candidate === record.sorting);
  const activity = ACTIVITY_PERIODS.find((candidate) => candidate === record.activity);
  const environmentValue = record.environmentIds ?? record.environments;
  const environmentIds = Array.isArray(environmentValue)
    ? [
        ...new Set(
          environmentValue.filter(
            (environment): environment is string =>
              typeof environment === "string" && environment.trim() !== "",
          ),
        ),
      ]
    : [];
  const range = normalizeActivityRange(record.activityRange);
  const statuses = normalizeStatuses(record.statuses);
  return {
    lifecycle: lifecycle ?? DEFAULT_PROJECT_VIEW_FILTERS.lifecycle,
    environmentIds,
    showEmptyProjects:
      typeof record.showEmptyProjects === "boolean"
        ? record.showEmptyProjects
        : DEFAULT_PROJECT_VIEW_FILTERS.showEmptyProjects,
    grouping: grouping ?? DEFAULT_PROJECT_VIEW_FILTERS.grouping,
    sorting: sorting ?? DEFAULT_PROJECT_VIEW_FILTERS.sorting,
    activity: activity ?? DEFAULT_PROJECT_VIEW_FILTERS.activity,
    ...(range === undefined ? {} : { activityRange: range }),
    ...(statuses === undefined ? {} : { statuses }),
  };
}

/**
 * The statuses a saved view asked for, or `undefined` when it asked for no
 * constraint.
 *
 * An absent field and an empty list both mean every status, so a view saved
 * before this field existed keeps showing what it showed. Unknown words are
 * dropped rather than rejected: a lens written by a newer build should narrow
 * to what this build understands, not empty itself. Dropping every word a
 * caller sent collapses back to no constraint for the same reason.
 */
function normalizeStatuses(value: unknown): ReadonlyArray<SidebarThreadStatus> | undefined {
  if (!Array.isArray(value)) return undefined;
  const statuses = SIDEBAR_THREAD_STATUS_ORDER.filter((status) => value.includes(status));
  return statuses.length === 0 ? undefined : statuses;
}

/**
 * Applies lifecycle and host-environment filters. Projects without an explicit
 * environment projection are local; a remote host is never inferred. Activity
 * does not hide a Project here — that happens only when empty Projects are off.
 */
export function filterProjectsForView<T extends ProjectViewProjectLike>(
  projects: ReadonlyArray<T>,
  filters: ProjectViewFilters,
  environmentByProjectId: ReadonlyMap<string, ProjectViewEnvironment> = new Map(),
): ReadonlyArray<T> {
  const normalized = normalizeProjectViewFilters(filters);
  return projects.filter((project) => {
    const lifecycle = project.lifecycle ?? "active";
    if (normalized.lifecycle !== "all" && lifecycle !== normalized.lifecycle) return false;
    if (normalized.environmentIds.length === 0) return true;
    const environment = environmentByProjectId.get(String(project.id));
    const environmentId = environment?.id ?? "local";
    return normalized.environmentIds.includes(environmentId);
  });
}

/**
 * Returns only the threads a saved view asks to see: those whose
 * server-authored `updatedAt` falls in its activity window and whose strongest
 * status is one it selected.
 *
 * The status test reads the thread's strongest status rather than any status it
 * holds, so asking for "Needs attention" shows the threads that are waiting on
 * the reader, not the ones that are already running and happen to also be
 * unread. That matches what the row and the Project heading show.
 */
export function filterProjectViewThreads<T extends ProjectViewThreadLike>(
  threads: ReadonlyArray<T>,
  filters: ProjectViewFilters,
  now: Date = new Date(),
): ReadonlyArray<T> {
  const statuses = normalizeStatuses(filters.statuses);
  const byStatus =
    statuses === undefined
      ? threads
      : threads.filter((thread) => {
          const status = resolveSidebarThreadStatus(threadStatusFacts(thread));
          return status !== undefined && statuses.includes(status);
        });
  if (filters.activity === "all") return byStatus;
  const range = projectViewActivityRange(filters, now);
  if (range === undefined) return byStatus;
  return byStatus.filter((thread) => {
    if (thread.updatedAt === undefined) return false;
    const timestamp = Date.parse(thread.updatedAt);
    if (Number.isNaN(timestamp)) return false;
    return timestamp >= range.from.getTime() && timestamp <= range.to.getTime();
  });
}

export function projectViewActivityRange(
  filters: ProjectViewFilters,
  now: Date = new Date(),
): { readonly from: Date; readonly to: Date } | undefined {
  if (filters.activity === "all") return undefined;
  if (filters.activity === "custom") {
    if (projectViewActivityRangeError(filters) !== undefined) return undefined;
    const from = parseLocalDateStart(filters.activityRange?.from);
    const to = parseLocalDateEnd(filters.activityRange?.to);
    if (from === undefined && to === undefined) return undefined;
    return {
      from: from ?? new Date(0),
      to: to ?? new Date(8640000000000000),
    };
  }
  const days =
    filters.activity === "today"
      ? 1
      : filters.activity === "3-days"
        ? 3
        : filters.activity === "7-days"
          ? 7
          : filters.activity === "14-days"
            ? 14
            : 30;
  const today = localDayStart(now);
  return {
    from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1),
    to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 0, 0, 0, -1),
  };
}

export function projectViewActivityRangeError(filters: ProjectViewFilters): string | undefined {
  if (filters.activity !== "custom") return undefined;
  const fromValue = filters.activityRange?.from;
  const toValue = filters.activityRange?.to;
  const from = parseLocalDateStart(fromValue);
  const to = parseLocalDateStart(toValue);
  if (fromValue !== undefined && fromValue !== "" && from === undefined) {
    return "Choose a valid start date.";
  }
  if (toValue !== undefined && toValue !== "" && to === undefined) {
    return "Choose a valid end date.";
  }
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    return "Start date must be on or before end date.";
  }
  return undefined;
}

/**
 * Orders the Projects a saved view shows.
 *
 * `status` leads with the Project holding the loudest thread and falls back to
 * recency, then name, for the Projects that report the same thing — including
 * every quiet Project, which keeps the tail of the list in the order a reader
 * already knows rather than shuffling it.
 */
export function sortProjectsForView<T extends ProjectViewProjectLike>(
  projects: ReadonlyArray<T>,
  sorting: ProjectViewSort,
  threads: ReadonlyArray<ProjectViewThreadLike>,
): ReadonlyArray<T> {
  const latestByProject = new Map<string, string>();
  for (const thread of threads) {
    if (thread.projectId === undefined || thread.updatedAt === undefined) continue;
    const current = latestByProject.get(thread.projectId);
    if (current === undefined || thread.updatedAt > current) {
      latestByProject.set(thread.projectId, thread.updatedAt);
    }
  }
  const rollups = new Map<string, ReturnType<typeof rollUpSidebarProjectStatus>>();
  if (sorting === "status") {
    const byProject = new Map<string, SidebarThreadStatusInput[]>();
    for (const thread of threads) {
      if (thread.projectId === undefined) continue;
      const bucket = byProject.get(thread.projectId);
      const facts = threadStatusFacts(thread);
      if (bucket === undefined) byProject.set(thread.projectId, [facts]);
      else bucket.push(facts);
    }
    for (const project of projects) {
      const id = String(project.id);
      rollups.set(id, rollUpSidebarProjectStatus(byProject.get(id) ?? []));
    }
  }
  return [...projects].sort((left, right) => {
    if (sorting === "status") {
      const byStatus = compareSidebarProjectStatus(
        rollups.get(String(left.id)),
        rollups.get(String(right.id)),
      );
      if (byStatus !== 0) return byStatus;
      const leftRecency = latestByProject.get(String(left.id)) ?? String(left.updatedAt ?? "");
      const rightRecency = latestByProject.get(String(right.id)) ?? String(right.updatedAt ?? "");
      return (
        rightRecency.localeCompare(leftRecency) ||
        (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "base" })
      );
    }
    if (sorting === "alphabetical") {
      return (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "base" });
    }
    if (sorting === "created") {
      const leftCreated = String(left.createdAt ?? "");
      const rightCreated = String(right.createdAt ?? "");
      return (
        rightCreated.localeCompare(leftCreated) ||
        (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "base" })
      );
    }
    const leftRecency = latestByProject.get(String(left.id)) ?? String(left.updatedAt ?? "");
    const rightRecency = latestByProject.get(String(right.id)) ?? String(right.updatedAt ?? "");
    return (
      rightRecency.localeCompare(leftRecency) ||
      (left.name ?? "").localeCompare(right.name ?? "", undefined, { sensitivity: "base" })
    );
  });
}

export function groupProjectsForView<T extends ProjectViewProjectLike>(
  projects: ReadonlyArray<T>,
  grouping: ProjectViewGrouping,
  environments?: ReadonlyMap<string, ProjectViewEnvironment>,
): ReadonlyArray<{ readonly label: string; readonly projects: ReadonlyArray<T> }> {
  if (grouping === "project") return [];
  const groups = new Map<string, T[]>();
  for (const project of projects) {
    const environment = environments?.get(String(project.id));
    const label =
      grouping === "none"
        ? "Projects"
        : grouping === "environment"
          ? (environment?.name ?? "Local")
          : project.lifecycle === "archived"
            ? "Archived"
            : "Active";
    const current = groups.get(label);
    if (current === undefined) groups.set(label, [project]);
    else current.push(project);
  }
  return [...groups.entries()].map(([label, grouped]) => ({ label, projects: grouped }));
}

function normalizeActivityRange(value: unknown): ProjectViewActivityRange | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { readonly from?: unknown; readonly to?: unknown };
  const from = normalizeDateOnly(record.from);
  const to = normalizeDateOnly(record.to);
  if (from === undefined && to === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function normalizeDateOnly(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return parseLocalDateStart(value) === undefined ? undefined : value;
}

function parseLocalDateStart(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function parseLocalDateEnd(value: string | undefined): Date | undefined {
  const start = parseLocalDateStart(value);
  if (start === undefined) return undefined;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  end.setMilliseconds(-1);
  return end;
}

function localDayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
