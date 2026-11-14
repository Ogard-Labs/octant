import type { MobileInboxRow } from "@octant/client-runtime";

/**
 * The desktop sidebar's three arrangements of one mode's threads
 * (docs/design/workspace.md › Sidebar): Status, the default, groups by what a
 * thread needs from the person; Projects groups by Project; Activity groups
 * by when a thread last changed. All three hold the same threads.
 */
export type MobileThreadArrangement = "status" | "projects" | "activity";

export const MOBILE_THREAD_ARRANGEMENTS: ReadonlyArray<{
  readonly id: MobileThreadArrangement;
  readonly label: string;
}> = [
  { id: "status", label: "Status" },
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
];

export interface MobileThreadGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: ReadonlyArray<MobileInboxRow>;
}

const NO_PROJECT = "No Project";

/** Newest first, ties by id, as the host lists them. */
function newestFirst(rows: ReadonlyArray<MobileInboxRow>): ReadonlyArray<MobileInboxRow> {
  return [...rows].sort((left, right) =>
    left.freshness === right.freshness
      ? left.threadId.localeCompare(right.threadId)
      : left.freshness < right.freshness
        ? 1
        : -1,
  );
}

/**
 * Status: Pinned, Needs input (an approval or answer waits, or review asked for
 * changes), Ready for review (a Code review waits or is approved and unmerged), Working (a turn runs), and
 * Idle. A thread appears once, under the first heading that holds it.
 */
function byStatus(rows: ReadonlyArray<MobileInboxRow>): ReadonlyArray<MobileThreadGroup> {
  const headings: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly holds: (row: MobileInboxRow) => boolean;
  }> = [
    { id: "pinned", label: "Pinned", holds: (row) => row.pinned === true },
    {
      id: "needs-input",
      label: "Needs input",
      holds: (row) => row.live === "needs-input" || row.reviewState === "changes-requested",
    },
    {
      id: "ready-for-review",
      label: "Ready for review",
      // Pending and approved both wait on the person, as the Inbox's In review count says.
      holds: (row) => row.reviewState === "pending" || row.reviewState === "approved",
    },
    { id: "working", label: "Working", holds: (row) => row.live === "working" },
    { id: "idle", label: "Idle", holds: () => true },
  ];
  const placed = new Set<MobileInboxRow>();
  const groups: MobileThreadGroup[] = [];
  for (const heading of headings) {
    const held = rows.filter((row) => !placed.has(row) && heading.holds(row));
    for (const row of held) placed.add(row);
    if (held.length > 0) groups.push({ id: heading.id, label: heading.label, rows: held });
  }
  return groups;
}

/**
 * Projects: one group per Project, the most recently active Project first, and
 * No Project (a Chat with no folder) last. A Project the phone has no name for
 * is still its own group rather than merged with another.
 */
function byProject(
  rows: ReadonlyArray<MobileInboxRow>,
  projectName: (row: MobileInboxRow) => string | undefined,
): ReadonlyArray<MobileThreadGroup> {
  const groups = new Map<string, { label: string; rows: MobileInboxRow[] }>();
  for (const row of rows) {
    const key = row.projectId === undefined ? "" : `${row.hostId}:${row.projectId}`;
    const label = row.projectId === undefined ? NO_PROJECT : (projectName(row) ?? "Project");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { label, rows: [row] });
    else group.rows.push(row);
  }
  return [...groups.entries()]
    .sort(([leftKey], [rightKey]) => (leftKey === "" ? 1 : rightKey === "" ? -1 : 0))
    .map(([key, group]) => ({ id: key === "" ? "no-project" : key, ...group }));
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Activity: Pinned, then Today, Yesterday, the weekday for the rest of the week, then Earlier. */
function byActivity(
  rows: ReadonlyArray<MobileInboxRow>,
  now: Date,
): ReadonlyArray<MobileThreadGroup> {
  const groups: MobileThreadGroup[] = [];
  const pinned = rows.filter((row) => row.pinned === true);
  if (pinned.length > 0) groups.push({ id: "pinned", label: "Pinned", rows: pinned });
  const today = startOfLocalDay(now);
  const buckets = new Map<string, MobileInboxRow[]>();
  for (const row of rows) {
    if (row.pinned === true) continue;
    const time = Date.parse(row.freshness);
    const days = Number.isNaN(time)
      ? Number.POSITIVE_INFINITY
      : Math.round((today - startOfLocalDay(new Date(time))) / 86_400_000);
    const label =
      days <= 0
        ? "Today"
        : days === 1
          ? "Yesterday"
          : days < 7
            ? new Date(time).toLocaleDateString("en-US", { weekday: "long" })
            : "Earlier";
    buckets.set(label, [...(buckets.get(label) ?? []), row]);
  }
  for (const [label, held] of buckets) {
    groups.push({ id: label.toLowerCase(), label, rows: held });
  }
  return groups;
}

export function arrangeMobileThreads(input: {
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly arrangement: MobileThreadArrangement;
  readonly projectName: (row: MobileInboxRow) => string | undefined;
  readonly now?: Date;
}): ReadonlyArray<MobileThreadGroup> {
  const rows = newestFirst(input.rows);
  if (input.arrangement === "projects") return byProject(rows, input.projectName);
  if (input.arrangement === "activity") return byActivity(rows, input.now ?? new Date());
  return byStatus(rows);
}
