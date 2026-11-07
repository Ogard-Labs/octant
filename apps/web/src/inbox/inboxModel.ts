import type { GithubAssignedWorkItem } from "@octant/contracts";
import type { LinearIssueRow } from "@octant/contracts/linear-issues";
import { decodeProjectId, type ProjectId } from "@octant/contracts/projects";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import type { PendingRequestRowEntry } from "../pendingRequests/usePendingRequestRows";
import { pendingRequestKey } from "../pendingRequests/pendingRequests";
import { visibleModeOf, type VisibleMode } from "../shell/workKind";

/**
 * One thread waiting on the user, ready to render: the raw signal plus the
 * Project name the sidebar already knows, so a row can say where the thread
 * lives without the view re-deriving it. `modeName` is set only when the
 * thread lives in the other mode: the Inbox lists every mode's threads, and a
 * row from elsewhere has to say where it is.
 */
export interface InboxAttentionItem {
  readonly signal: ThreadAttentionSignal;
  readonly projectName?: string;
  readonly modeName?: string;
}

const VISIBLE_MODE_NAMES: Readonly<Record<VisibleMode, string>> = {
  work: "Work",
  code: "Code",
};

/**
 * An approval or question stops an agent cold, so it outranks a due follow-up,
 * and a finished turn only waits for what is next. A finished turn is listed
 * only under the Finished filter; see `matchesInboxFilter`.
 */
const REASON_PRIORITY: Readonly<Record<ThreadAttentionSignal["reason"], number>> = {
  "approval-required": 0,
  "question-asked": 1,
  "follow-up-due": 2,
  "turn-finished": 3,
};

const ATTENTION_REASON_LABELS: Readonly<Record<ThreadAttentionSignal["reason"], string>> = {
  "approval-required": "Waiting for approval",
  "question-asked": "Asked a question",
  "follow-up-due": "Follow-up due",
  "turn-finished": "Finished a turn",
};

/** The meta line under a row: why it is here, then where the thread lives. */
export function inboxAttentionMeta(item: InboxAttentionItem): string {
  return [ATTENTION_REASON_LABELS[item.signal.reason], item.projectName, item.modeName]
    .filter((part) => part !== undefined)
    .join(" · ");
}

export function buildInboxAttentionItems(
  signals: ReadonlyArray<ThreadAttentionSignal>,
  projectNames: ReadonlyMap<string, string>,
  currentMode: VisibleMode,
): ReadonlyArray<InboxAttentionItem> {
  const seen = new Set<string>();
  const items: InboxAttentionItem[] = [];
  for (const signal of signals) {
    const key = `${signal.threadId} ${signal.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projectName =
      signal.projectId === undefined ? undefined : projectNames.get(signal.projectId);
    const threadMode = visibleModeOf(signal.source);
    items.push({
      signal,
      ...(projectName === undefined ? {} : { projectName }),
      ...(threadMode === currentMode ? {} : { modeName: VISIBLE_MODE_NAMES[threadMode] }),
    });
  }
  return items.toSorted(
    (left, right) =>
      REASON_PRIORITY[left.signal.reason] - REASON_PRIORITY[right.signal.reason] ||
      left.signal.title.localeCompare(right.signal.title),
  );
}

export const ASSIGNED_WORK_CATEGORY_LABELS: Readonly<
  Record<GithubAssignedWorkItem["category"], string>
> = {
  issue: "Issue",
  "pull-request": "Pull request",
  "review-request": "Review requested",
};

/**
 * Seen keys carry the update timestamp so an item that moves on GitHub lights
 * up again; a Linear row exposes no timestamp, so its key is identity only.
 */
export function assignedWorkSeenKey(item: GithubAssignedWorkItem): string {
  return `github:${item.owner}/${item.name}#${item.number}:${item.updatedAt}`;
}

export function linearIssueSeenKey(row: LinearIssueRow): string {
  return `linear:${row.id}`;
}

/** Decode the signal's Project so cross-Project opens can switch Project. */
export function inboxThreadProjectId(signal: ThreadAttentionSignal): ProjectId | undefined {
  return signal.projectId === undefined ? undefined : decodeProjectId(signal.projectId);
}

export type InboxFilter = "all" | "urgent" | "decide" | "stuck" | "finished";

export const INBOX_FILTERS: ReadonlyArray<{
  readonly id: InboxFilter;
  readonly label: string;
  /** The line shown when the filter matches nothing. */
  readonly empty: string;
}> = [
  { id: "all", label: "All", empty: "No thread is waiting on you" },
  { id: "urgent", label: "Urgent", empty: "Nothing urgent." },
  { id: "decide", label: "Decide", empty: "No decisions waiting." },
  { id: "stuck", label: "Stuck", empty: "Nothing stuck." },
  { id: "finished", label: "Finished", empty: "No finished turns waiting." },
];

/**
 * One thing waiting on the person, ready to filter and group: a pending
 * request (answered in place) or a thread's attention signal (opened).
 * `since` is when the wait began, which a signal does not record.
 */
export type InboxWaitingItem = {
  readonly key: string;
  readonly projectKey: string | undefined;
  readonly urgent: boolean;
  readonly deferred: boolean;
  readonly since: number | undefined;
} & (
  | { readonly kind: "request"; readonly entry: PendingRequestRowEntry }
  | { readonly kind: "attention"; readonly item: InboxAttentionItem }
);

export function inboxWaitingItems(
  requests: ReadonlyArray<PendingRequestRowEntry>,
  attention: ReadonlyArray<InboxAttentionItem>,
  now: number,
): ReadonlyArray<InboxWaitingItem> {
  return [
    ...requests.map((entry): InboxWaitingItem => {
      const { request } = entry;
      return {
        kind: "request",
        entry,
        key: pendingRequestKey(request),
        projectKey: request.projectId === undefined ? undefined : String(request.projectId),
        urgent: request.kind === "decision" && request.urgent === true,
        deferred: request.deferredUntil !== undefined && Date.parse(request.deferredUntil) > now,
        since: Date.parse(request.requestedAt),
      };
    }),
    ...attention.map(
      (item): InboxWaitingItem => ({
        kind: "attention",
        item,
        key: `${item.signal.threadId}:${item.signal.reason}`,
        projectKey: item.signal.projectId,
        urgent: false,
        deferred: false,
        since: undefined,
      }),
    ),
  ];
}

/**
 * All is what waits on the person today; a finished turn waits for what is
 * next, so only its own filter lists it. Stuck is every wait that is not a
 * decision: approvals, questions, and waiting subagents.
 */
export function matchesInboxFilter(item: InboxWaitingItem, filter: InboxFilter): boolean {
  const finished = item.kind === "attention" && item.item.signal.reason === "turn-finished";
  switch (filter) {
    case "all":
      return !finished;
    case "urgent":
      return item.urgent;
    case "decide":
      return item.kind === "request" && item.entry.request.kind === "decision";
    case "stuck":
      return item.kind === "request"
        ? item.entry.request.kind !== "decision"
        : item.item.signal.reason === "approval-required" ||
            item.item.signal.reason === "question-asked";
    case "finished":
      return finished;
  }
}

export function inboxFilterCounts(
  items: ReadonlyArray<InboxWaitingItem>,
): Readonly<Record<InboxFilter, number>> {
  const count = (filter: InboxFilter) =>
    items.filter((item) => matchesInboxFilter(item, filter)).length;
  return {
    all: count("all"),
    urgent: count("urgent"),
    decide: count("decide"),
    stuck: count("stuck"),
    finished: count("finished"),
  };
}

export interface InboxProjectGroup {
  /** Empty for waits that belong to no Project. */
  readonly projectKey: string;
  readonly name: string;
  readonly items: ReadonlyArray<InboxWaitingItem>;
  readonly urgentCount: number;
}

export const NO_PROJECT_NAME = "No Project";

const waitingRank = (item: InboxWaitingItem) => (item.urgent ? 0 : item.deferred ? 2 : 1);
const oldestFirst = (left: number | undefined, right: number | undefined) =>
  (left ?? Number.POSITIVE_INFINITY) === (right ?? Number.POSITIVE_INFINITY)
    ? 0
    : (left ?? Number.POSITIVE_INFINITY) < (right ?? Number.POSITIVE_INFINITY)
      ? -1
      : 1;

/**
 * Groups waits under their Project. Groups holding an urgent wait lead, then
 * the group that has waited longest; inside a group urgent waits come first,
 * then the rest oldest first, then deferred ones.
 */
export function groupInboxByProject(
  items: ReadonlyArray<InboxWaitingItem>,
  projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<InboxProjectGroup> {
  const byProject = new Map<string, InboxWaitingItem[]>();
  for (const item of items) {
    // A Project this window cannot name joins the one No Project group rather
    // than heading a second group under the same name.
    const key =
      item.projectKey !== undefined && projectNames.has(item.projectKey) ? item.projectKey : "";
    byProject.set(key, [...(byProject.get(key) ?? []), item]);
  }
  const groups = [...byProject].map(([projectKey, members]): InboxProjectGroup => {
    const sorted = members.toSorted(
      (left, right) =>
        waitingRank(left) - waitingRank(right) || oldestFirst(left.since, right.since),
    );
    return {
      projectKey,
      name: projectNames.get(projectKey) ?? NO_PROJECT_NAME,
      items: sorted,
      urgentCount: sorted.filter((item) => item.urgent).length,
    };
  });
  const oldest = (group: InboxProjectGroup) =>
    group.items.reduce<number | undefined>(
      (best, item) =>
        item.since !== undefined && (best === undefined || item.since < best) ? item.since : best,
      undefined,
    );
  return groups.toSorted(
    (left, right) =>
      Number(right.urgentCount > 0) - Number(left.urgentCount > 0) ||
      oldestFirst(oldest(left), oldest(right)) ||
      left.name.localeCompare(right.name),
  );
}
