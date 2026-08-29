import type { GithubAssignedWorkItem } from "@octant/contracts";
import type { LinearIssueRow } from "@octant/contracts/linear-issues";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";

/**
 * One thread waiting on the user, ready to render: the raw signal plus the
 * Project name the sidebar already knows, so a row can say where the thread
 * lives without the view re-deriving it.
 */
export interface InboxAttentionItem {
  readonly signal: ThreadAttentionSignal;
  readonly projectName?: string;
}

/**
 * Blocked threads outrank finished ones: an approval or question stops an
 * agent cold, while a finished turn merely waits to be read.
 */
const REASON_PRIORITY: Readonly<Record<ThreadAttentionSignal["reason"], number>> = {
  "approval-required": 0,
  "question-asked": 1,
  "turn-finished": 2,
};

export const ATTENTION_REASON_LABELS: Readonly<Record<ThreadAttentionSignal["reason"], string>> = {
  "approval-required": "Waiting for approval",
  "question-asked": "Asked a question",
  "turn-finished": "Finished a turn",
};

export function buildInboxAttentionItems(
  signals: ReadonlyArray<ThreadAttentionSignal>,
  projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<InboxAttentionItem> {
  const seen = new Set<string>();
  const items: InboxAttentionItem[] = [];
  for (const signal of signals) {
    const key = `${signal.threadId} ${signal.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const projectName =
      signal.projectId === undefined ? undefined : projectNames.get(signal.projectId);
    items.push({ signal, ...(projectName === undefined ? {} : { projectName }) });
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
