import type { ChatThreadNavigationItem } from "./navigationModel";

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

export interface SidebarActivityThread {
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

export function readActivityViewEnabled(
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
  mode: SidebarActivityMode = "chat",
): boolean {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return false;
    migrateLegacyActivityView(resolved);
    return resolved.getItem(activityViewStorageKey(mode)) === "on";
  } catch {
    return false;
  }
}

export function writeActivityViewEnabled(
  enabled: boolean,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  storageHolder: { readonly localStorage?: Storage } = globalThis,
  mode: SidebarActivityMode = "chat",
): void {
  try {
    const resolved = resolveStorage(storage, storageHolder);
    if (resolved === undefined) return;
    migrateLegacyActivityView(resolved);
    resolved.setItem(activityViewStorageKey(mode), enabled ? "on" : "off");
  } catch {
    // Presentation persistence is best-effort; the current session still toggles.
  }
}

export function buildSidebarActivityView(input: {
  readonly now?: Date;
  readonly projects: ReadonlyArray<SidebarActivityProject>;
  readonly unfiledLabel?: "Unfiled" | "Recents";
  readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
}): SidebarActivityView {
  const now = input.now ?? new Date();
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));
  const rows = input.threads
    .map((thread) => toActivityThread(thread, projectNames, input.unfiledLabel ?? "Unfiled"))
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

function toActivityThread(
  thread: ChatThreadNavigationItem,
  projectNames: ReadonlyMap<string, string>,
  unfiledLabel: "Unfiled" | "Recents",
): SidebarActivityThread {
  const projectName =
    thread.projectId === undefined
      ? unfiledLabel
      : (projectNames.get(thread.projectId) ?? unfiledLabel);
  return {
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

function recencyBucket(updatedAt: string | undefined, now: Date): { id: string; label: string } {
  if (updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))) {
    return { id: "earlier", label: "Earlier" };
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
  return { id: "earlier", label: "Earlier" };
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
    { id: "earlier", label: "Earlier" },
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
