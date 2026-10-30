import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import {
  threadRowActivity,
  type ChatThreadNavigationItem,
  type ThreadCheckoutChip,
  type ThreadRowActivity,
} from "./navigationModel";

export const ACTIVITY_VIEW_STORAGE_KEY = "octant.sidebar.activity-view.v1";
export const ALL_ACTIVITY_VIEW_MODES = ["chat", "work", "code"] as const;
export type SidebarActivityMode = (typeof ALL_ACTIVITY_VIEW_MODES)[number];

function activityViewStorageKey(mode: SidebarActivityMode = "chat"): string {
  return `${ACTIVITY_VIEW_STORAGE_KEY}.${mode}`;
}

function resolveStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
  storageHolder: { readonly localStorage?: Storage },
): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  return storage ?? storageHolder.localStorage;
}

function migrateLegacyActivityView(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  const legacy = storage.getItem(ACTIVITY_VIEW_STORAGE_KEY);
  if (legacy === null) return;
  for (const mode of ALL_ACTIVITY_VIEW_MODES) {
    if (storage.getItem(activityViewStorageKey(mode)) === null) {
      storage.setItem(activityViewStorageKey(mode), legacy);
    }
  }
  storage.removeItem(ACTIVITY_VIEW_STORAGE_KEY);
}

export type SidebarActivityAttention = "unread" | "follow-up" | "live" | "none";

export interface SidebarActivityProject {
  readonly id: string;
  readonly name: string;
}

export interface SidebarActivityThread extends ChatThreadNavigationItem {
  readonly activity: ThreadRowActivity;
  /**
   * The row properties the Activity feed can show beside the Project name.
   * They are carried whether or not the view currently shows them, because
   * which of them a row wears is a per-view display choice, not a fact about
   * the thread.
   */
  readonly checkoutChip?: ThreadCheckoutChip;
  readonly pullRequests?: ThreadBoardPullRequestSummaries;
  readonly wakeLabel?: string;
  readonly unread: boolean;
  readonly followUp: boolean;
  readonly woke: boolean;
  readonly attention: SidebarActivityAttention;
  readonly pinned?: boolean;
  readonly navigationId: string;
  readonly projectName: string;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt?: string;
}

export interface SidebarActivityGroup {
  readonly id: string;
  readonly label: string;
  readonly threads: ReadonlyArray<SidebarActivityThread>;
}

export interface SidebarActivityView {
  readonly groups: ReadonlyArray<SidebarActivityGroup>;
}

/**
 * How a mode's sidebar arranges its threads: by Project, by when they last
 * moved (the Activity feed), or by what each one needs (Status).
 */
export type SidebarThreadArrangement = "projects" | "activity" | "status";

// The stored words predate Status: "on" was the feed and "off" the tree, so
// they keep those meanings and an existing choice survives.
const STORED_ARRANGEMENT: Readonly<Record<string, SidebarThreadArrangement>> = {
  on: "activity",
  off: "projects",
  status: "status",
};
const ARRANGEMENT_WORD: Readonly<Record<SidebarThreadArrangement, string>> = {
  activity: "on",
  projects: "off",
  status: "status",
};

/**
 * The arrangement this mode's sidebar shows. A mode nobody has chosen for
 * opens on Status, as does any storage that cannot be read.
 */
export function readThreadArrangement(
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
  mode: SidebarActivityMode = "chat",
): SidebarThreadArrangement {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return "status";
    migrateLegacyActivityView(resolved);
    return STORED_ARRANGEMENT[resolved.getItem(activityViewStorageKey(mode)) ?? ""] ?? "status";
  } catch {
    return "status";
  }
}

export function writeThreadArrangement(
  arrangement: SidebarThreadArrangement,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
  mode: SidebarActivityMode = "chat",
): void {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return;
    migrateLegacyActivityView(resolved);
    resolved.setItem(activityViewStorageKey(mode), ARRANGEMENT_WORD[arrangement]);
  } catch {
    // Presentation persistence is best-effort; the current session still toggles.
  }
}

const FOLDED_STATUS_GROUPS_STORAGE_KEY = "octant.sidebar.folded-status-groups.v1";

/**
 * The Status groups this window has folded. Session storage keeps the choice
 * per window, as a folded Project is, and across a reload of that window.
 */
export function readFoldedStatusGroups(
  mode: SidebarActivityMode = "chat",
  storageHolder: { readonly sessionStorage?: Storage } = globalThis,
): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      storageHolder.sessionStorage?.getItem(`${FOLDED_STATUS_GROUPS_STORAGE_KEY}.${mode}`) ?? "[]",
    );
    return new Set(
      Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function writeFoldedStatusGroups(
  folded: ReadonlySet<string>,
  mode: SidebarActivityMode = "chat",
  storageHolder: { readonly sessionStorage?: Storage } = globalThis,
): void {
  try {
    storageHolder.sessionStorage?.setItem(
      `${FOLDED_STATUS_GROUPS_STORAGE_KEY}.${mode}`,
      JSON.stringify([...folded]),
    );
  } catch {
    // Presentation persistence is best-effort; the current window still folds.
  }
}

/**
 * Sidebar Search is an in-place filter of the rows already on screen.
 * Project, Recents, and Unfiled are folder words on a thread, so a query
 * that names the folder keeps those rows instead of hiding the attribution
 * that tells you where the match lives.
 */
export function matchesSidebarSearch(query: string, ...values: ReadonlyArray<string>): boolean {
  const needle = normalizeSearchText(query);
  if (needle === "") return true;
  return values.some((value) => normalizeSearchText(value).includes(needle));
}

export function filterSidebarActivityView(
  view: SidebarActivityView,
  query: string,
): SidebarActivityView {
  if (normalizeSearchText(query) === "") return view;
  return {
    groups: view.groups
      .map((group) => ({
        ...group,
        threads: group.threads.filter((thread) =>
          matchesSidebarSearch(query, thread.title, thread.projectName),
        ),
      }))
      .filter((group) => group.threads.length > 0),
  };
}

export function buildSidebarActivityView(input: {
  readonly now?: Date;
  readonly projects: ReadonlyArray<SidebarActivityProject>;
  readonly unfiledLabel?: "No Project" | "Unfiled" | "Recents" | "Chats";
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}): SidebarActivityView {
  const now = input.now ?? new Date();
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const rows = input.threads
    .map((thread) => toActivityThread(thread, projectNames, input.unfiledLabel ?? "No Project"))
    .sort(compareActivityThreads);
  // A pin is the user saying "keep this where I can see it", so it outranks
  // both attention and recency; a pinned thread that also needs attention still
  // shows its mark, it just does not move.
  const pinned = rows.filter((thread) => thread.pinned === true);
  const unpinned = rows.filter((thread) => thread.pinned !== true);
  const priority = unpinned.filter(
    (thread) => thread.attention === "unread" || thread.attention === "follow-up",
  );
  const remaining = unpinned.filter(
    (thread) => thread.attention !== "unread" && thread.attention !== "follow-up",
  );
  const groups: SidebarActivityGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ id: "pinned", label: "Pinned", threads: pinned });
  }
  if (priority.length > 0) {
    groups.push({ id: "priority", label: "Priority", threads: priority });
  }
  const buckets = new Map<string, SidebarActivityThread[]>();
  for (const thread of remaining) {
    const bucket = recencyBucket(thread.updatedAt, now);
    const existing = buckets.get(bucket.id);
    if (existing === undefined) buckets.set(bucket.id, [thread]);
    else existing.push(thread);
  }
  for (const bucket of recencyBucketOrder(now)) {
    const threads = buckets.get(bucket.id);
    if (threads === undefined || threads.length === 0) continue;
    groups.push({ id: bucket.id, label: bucket.label, threads });
  }
  return { groups };
}

/**
 * The Status arrangement: what each thread needs from the person, in the
 * order they would act on it. Pinned comes first, as in the feed. A thread
 * waiting on an approval or an answer needs input; a finished turn nobody has
 * looked at is ready for review; a running turn is working; everything else is
 * idle. Each group lists its newest threads first.
 */
export function buildSidebarStatusView(input: {
  readonly projects: ReadonlyArray<SidebarActivityProject>;
  readonly unfiledLabel?: "No Project" | "Unfiled" | "Recents" | "Chats";
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}): SidebarActivityView {
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const rows = input.threads
    .map((thread) => toActivityThread(thread, projectNames, input.unfiledLabel ?? "No Project"))
    .sort(compareActivityThreads);
  const buckets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly holds: (thread: SidebarActivityThread) => boolean;
  }> = [
    { id: "pinned", label: "Pinned", holds: (thread) => thread.pinned === true },
    { id: "needs-input", label: "Needs input", holds: (thread) => thread.activity === "attention" },
    {
      id: "ready-for-review",
      label: "Ready for review",
      holds: (thread) => thread.activity === "unread",
    },
    { id: "working", label: "Working", holds: (thread) => thread.activity === "working" },
    { id: "idle", label: "Idle", holds: () => true },
  ];
  const placed = new Set<string>();
  const groups: SidebarActivityGroup[] = [];
  for (const bucket of buckets) {
    const threads = rows.filter(
      (thread) => !placed.has(thread.navigationId) && bucket.holds(thread),
    );
    for (const thread of threads) placed.add(thread.navigationId);
    if (threads.length > 0) groups.push({ id: bucket.id, label: bucket.label, threads });
  }
  return { groups };
}

function toActivityThread(
  thread: ChatThreadNavigationItem,
  projectNames: ReadonlyMap<string, string>,
  unfiledLabel: "No Project" | "Unfiled" | "Recents" | "Chats",
): SidebarActivityThread {
  const projectName =
    thread.projectId === undefined
      ? unfiledLabel
      : (projectNames.get(thread.projectId) ?? unfiledLabel);
  const activity = threadRowActivity(thread);
  return {
    ...thread,
    activity,
    ...(thread.checkoutChip === undefined ? {} : { checkoutChip: thread.checkoutChip }),
    ...(thread.pullRequests === undefined ? {} : { pullRequests: thread.pullRequests }),
    ...(thread.wakeLabel === undefined ? {} : { wakeLabel: thread.wakeLabel }),
    unread: activity === "unread" || thread.unread === true,
    followUp: thread.followUp === true,
    woke: thread.woke === true,
    attention: activityAttention(thread),
    ...(thread.pinned === true ? { pinned: true } : {}),
    navigationId: thread.navigationId ?? thread.threadId,
    projectName,
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
  };
}

function activityAttention(thread: ChatThreadNavigationItem): SidebarActivityAttention {
  if (thread.unread === true) return "unread";
  if (thread.followUp === true) return "follow-up";
  if (thread.meta === "waiting" || thread.meta === "interrupted") return "live";
  return "none";
}

function compareActivityThreads(left: SidebarActivityThread, right: SidebarActivityThread): number {
  const leftStamp = left.updatedAt ?? "";
  const rightStamp = right.updatedAt ?? "";
  if (leftStamp !== rightStamp) return rightStamp.localeCompare(leftStamp);
  return left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
  });
}

/**
 * The one recency group with no far edge: everything older than a week. The
 * feed folds it, so the id is shared rather than spelled where it is tested.
 */
export const EARLIER_ACTIVITY_GROUP_ID = "earlier";

function recencyBucket(updatedAt: string | undefined, now: Date): { id: string; label: string } {
  if (updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))) {
    return { id: EARLIER_ACTIVITY_GROUP_ID, label: "Earlier" };
  }
  const updated = startOfLocalDay(new Date(updatedAt));
  const today = startOfLocalDay(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round((today.getTime() - updated.getTime()) / dayMs);
  if (deltaDays <= 0) return { id: "today", label: "Today" };
  if (deltaDays === 1) return { id: "yesterday", label: "Yesterday" };
  if (deltaDays < 7) {
    return {
      id: weekdayId(updated),
      label: weekdayLabel(updated),
    };
  }
  return { id: EARLIER_ACTIVITY_GROUP_ID, label: "Earlier" };
}

function recencyBucketOrder(now: Date): ReadonlyArray<{ id: string; label: string }> {
  const today = startOfLocalDay(now);
  const weekdayBuckets = [2, 3, 4, 5, 6].map((offset) => {
    const date = addLocalDays(today, -offset);
    return { id: weekdayId(date), label: weekdayLabel(date) };
  });
  return [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    ...weekdayBuckets,
    { id: EARLIER_ACTIVITY_GROUP_ID, label: "Earlier" },
  ];
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function weekdayId(date: Date): string {
  return weekdayLabel(date).toLowerCase();
}

function weekdayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(date);
}

function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
