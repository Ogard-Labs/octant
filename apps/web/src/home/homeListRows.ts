import type { CodeBoardCard, GithubAssignedWorkItem, LinearIssueRow } from "@octant/contracts";
import type { RepositoryIssueRow } from "../github/readIssuesAcrossRepositories";
import { compactRelativeTimeLabel, elapsedLabel } from "../lib/relativeTime";
import {
  pullRequestListId,
  threadListId,
  type HomeListRow,
  type HomeListSectionId,
  type HomeListTone,
} from "./homeListModel";
import { pullRequestCardStatus, type PullRequestCardRow } from "./pullRequests";
import type { WorkingNowRow } from "./workingNow";

/**
 * Rows for the start screen's list, one builder per kind of source. A row says
 * what a person needs to place it: where it lives, its number, how old it is.
 * It never says what the section already says ("Your pull request"), and it
 * names the author only when the author is someone else.
 */

const TONE_BY_STATUS: Readonly<Record<string, HomeListTone>> = {
  positive: "positive",
  warning: "warning",
  negative: "negative",
  neutral: "neutral",
};

/**
 * A pull request of the Pull requests read. The first group waits on the
 * person's review, so its author is somebody else and named; the second is the
 * person's own and never says so.
 */
export function pullRequestListRow(
  row: PullRequestCardRow,
  section: "needs-you" | "your-pull-requests",
  now: number,
  onOpen: () => void,
): HomeListRow {
  const status = pullRequestCardStatus(row);
  return {
    id: pullRequestListId(row.repositoryOwner, row.repositoryName, row.number),
    section,
    glyph: row.review === "draft" ? "pull-request-draft" : "pull-request",
    tone: TONE_BY_STATUS[status.tone] ?? "neutral",
    label: status.word,
    title: row.title,
    meta: [
      row.repositoryName,
      `#${String(row.number)}`,
      ...(section === "needs-you" ? [row.author] : []),
      compactRelativeTimeLabel(row.updatedAt, now),
    ],
    at: row.updatedAt,
    ...(status.tone === "neutral" ? {} : { trailing: status.word }),
    onOpen,
  };
}

/** A thread or agent run that is running now. */
export function workingNowListRow(
  row: WorkingNowRow,
  now: number,
  onOpen: () => void,
): HomeListRow {
  const since =
    row.startedAt !== undefined
      ? `Running ${elapsedLabel(row.startedAt, now)}`
      : row.activeAt !== undefined
        ? `Active ${compactRelativeTimeLabel(row.activeAt, now)}`
        : "";
  return {
    id: row.runId === undefined ? threadListId(row.threadId) : `run:${row.runId}`,
    section: "in-progress",
    glyph: "running",
    tone: "running",
    label: "Running",
    title: row.title,
    meta: [row.projectName ?? "", row.step ?? "", row.host ?? "", since],
    onOpen,
  };
}

/** What an assigned GitHub item is, as a row under the section it belongs to. */
export function assignedGithubListRow(
  item: GithubAssignedWorkItem,
  now: number,
  onOpen: () => void,
): HomeListRow {
  const section: HomeListSectionId =
    item.category === "pull-request" ? "your-pull-requests" : "needs-you";
  const reference = [item.name, `#${String(item.number)}`];
  const age = compactRelativeTimeLabel(item.updatedAt, now);
  if (item.category === "issue") {
    return {
      id: `issue:${item.owner.toLowerCase()}/${item.name.toLowerCase()}#${String(item.number)}`,
      section,
      glyph: "issue",
      tone: "neutral",
      label: "Assigned issue",
      title: item.title,
      meta: [...reference, age],
      at: item.updatedAt,
      onOpen,
    };
  }
  return {
    id: pullRequestListId(item.owner, item.name, item.number),
    section,
    glyph: "pull-request",
    tone: "neutral",
    label: item.category === "review-request" ? "Review requested" : "Open",
    title: item.title,
    meta: [...reference, ...(item.category === "review-request" ? [item.author] : []), age],
    at: item.updatedAt,
    onOpen,
  };
}

export function assignedLinearListRow(row: LinearIssueRow, onOpen: (() => void) | undefined) {
  return {
    id: `linear:${String(row.id)}`,
    section: "needs-you",
    glyph: "issue",
    tone: "neutral",
    label: "Assigned issue",
    title: row.title,
    meta: [row.identifier, row.state.name],
    ...(onOpen === undefined ? {} : { onOpen }),
  } satisfies HomeListRow;
}

export interface ContinueBadge {
  readonly label: string;
  readonly tone: "running" | "done" | "open" | "waiting" | "quiet";
  readonly detail?: string;
}

/**
 * The badge names the thread's own state: running beats the board status.
 * The pull request is a fact beside the branch, not the badge, so a merged
 * thread and a merged pull request read as two things. Changed lines ride
 * along when the checkout has any.
 */
export function continueBadge(card: CodeBoardCard): ContinueBadge {
  const detail =
    card.changedFiles.kind === "observed" &&
    (card.changedFiles.insertions > 0 || card.changedFiles.deletions > 0)
      ? `+${String(card.changedFiles.insertions)} −${String(card.changedFiles.deletions)}`
      : undefined;
  const withDetail = (badge: Omit<ContinueBadge, "detail">): ContinueBadge =>
    detail === undefined ? badge : { ...badge, detail };
  if (card.executing) return withDetail({ label: "Running", tone: "running" });
  switch (card.status) {
    case "done":
      return withDetail({ label: "Done", tone: "done" });
    case "waiting":
      return withDetail({ label: "Waiting", tone: "waiting" });
    case "in-progress":
      return withDetail({ label: "In progress", tone: "open" });
    case "ready":
      return withDetail({ label: "Ready", tone: "quiet" });
  }
}

const CONTINUE_TONES = {
  running: "running",
  done: "positive",
  waiting: "warning",
  open: "neutral",
  quiet: "neutral",
} as const satisfies Readonly<Record<string, HomeListTone>>;

/** A thread worth picking back up, with where it stands at the title's edge. */
export function continueListRow(input: {
  readonly card: CodeBoardCard;
  readonly badge: ContinueBadge;
  readonly projectName: string | undefined;
  readonly now: number;
  readonly onOpen: (() => void) | undefined;
}): HomeListRow {
  const { card } = input;
  const branch =
    card.worktree.kind === "available" && card.worktree.head.kind === "branch"
      ? card.worktree.head.name
      : "";
  const at = card.lastMeaningfulActivityAt;
  return {
    id: threadListId(String(card.threadId)),
    section: "continue",
    glyph: "thread",
    tone: CONTINUE_TONES[input.badge.tone],
    label: input.badge.label,
    title: card.title,
    meta: [
      input.projectName ?? "",
      branch,
      at === null ? "" : compactRelativeTimeLabel(at, input.now),
    ],
    ...(at === null ? {} : { at }),
    trailing: input.badge.label,
    ...(input.onOpen === undefined ? {} : { onOpen: input.onOpen }),
  };
}

/** An open issue nobody has taken; picking it starts a thread from it. */
export function openIssueListRow(
  row: RepositoryIssueRow,
  now: number,
  onOpen: () => void,
): HomeListRow {
  return {
    id: `issue:${row.owner.toLowerCase()}/${row.name.toLowerCase()}#${String(row.number)}`,
    section: "open-issues",
    glyph: "issue",
    tone: "neutral",
    label: "Open issue",
    title: row.title,
    meta: [row.name, `#${String(row.number)}`, compactRelativeTimeLabel(row.updatedAt, now)],
    at: row.updatedAt,
    onOpen,
  };
}

export function openLinearListRow(
  row: LinearIssueRow,
  onOpen: (() => void) | undefined,
): HomeListRow {
  return {
    ...assignedLinearListRow(row, onOpen),
    section: "open-issues",
    label: "Open issue",
  };
}
