import type { CodeProjectPullRequestRow } from "@octant/contracts";
import { relativeTimeLabel } from "../lib/relativeTime";

/**
 * The page's ordering and narrowing of the cached rows. The rows carry the time
 * of the last update and no creation time, so the orders offered are the ones
 * the row's own age can answer.
 */
export type PullRequestSort = "updated" | "stalest" | "repository";
export type PullRequestStateFilter = "any" | "open" | "draft";
export type PullRequestReviewFilter = "any" | "approved" | "changes-requested" | "needs-review";
export type PullRequestChecksFilter = "any" | "passing" | "failing" | "pending";

export interface PullRequestFilters {
  readonly state: PullRequestStateFilter;
  readonly review: PullRequestReviewFilter;
  readonly checks: PullRequestChecksFilter;
}

export const NO_PULL_REQUEST_FILTERS: PullRequestFilters = {
  state: "any",
  review: "any",
  checks: "any",
};

export const PULL_REQUEST_SORT_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestSort;
  readonly label: string;
}> = [
  { value: "updated", label: "Recently updated" },
  { value: "stalest", label: "Least recently updated" },
  { value: "repository", label: "Repository" },
];

export const PULL_REQUEST_STATE_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestStateFilter;
  readonly label: string;
}> = [
  { value: "any", label: "Any state" },
  { value: "open", label: "Open" },
  { value: "draft", label: "Draft" },
];

export const PULL_REQUEST_REVIEW_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestReviewFilter;
  readonly label: string;
}> = [
  { value: "any", label: "Any review" },
  { value: "needs-review", label: "Needs review" },
  { value: "changes-requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
];

export const PULL_REQUEST_CHECKS_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestChecksFilter;
  readonly label: string;
}> = [
  { value: "any", label: "Any checks" },
  { value: "passing", label: "Checks passing" },
  { value: "failing", label: "Checks failing" },
  { value: "pending", label: "Checks pending" },
];

export function activeFilterCount(filters: PullRequestFilters): number {
  return (
    (filters.state === "any" ? 0 : 1) +
    (filters.review === "any" ? 0 : 1) +
    (filters.checks === "any" ? 0 : 1)
  );
}

function timeOf(row: CodeProjectPullRequestRow): number {
  const parsed = Date.parse(row.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function repositoryName(row: CodeProjectPullRequestRow): string {
  return `${row.repositoryOwner}/${row.repositoryName}`;
}

export function sortPullRequests(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
  sort: PullRequestSort,
): ReadonlyArray<CodeProjectPullRequestRow> {
  const newestFirst = (a: CodeProjectPullRequestRow, b: CodeProjectPullRequestRow) =>
    timeOf(b) - timeOf(a) || b.number - a.number;
  const copy = [...rows];
  if (sort === "stalest") return copy.sort((a, b) => -newestFirst(a, b));
  if (sort === "repository") {
    return copy.sort(
      (a, b) =>
        repositoryName(a).localeCompare(repositoryName(b), undefined, { sensitivity: "base" }) ||
        newestFirst(a, b),
    );
  }
  return copy.sort(newestFirst);
}

export function filterPullRequests(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
  filters: PullRequestFilters,
): ReadonlyArray<CodeProjectPullRequestRow> {
  return rows.filter((row) => {
    if (filters.state === "draft" && !row.draft) return false;
    if (filters.state === "open" && row.draft) return false;
    if (filters.review === "needs-review" && row.review !== "pending" && row.review !== "none") {
      return false;
    }
    if (
      (filters.review === "approved" || filters.review === "changes-requested") &&
      row.review !== filters.review
    ) {
      return false;
    }
    if (filters.checks !== "any" && row.checks !== filters.checks) return false;
    return true;
  });
}

export interface PullRequestRepositoryGroup {
  readonly key: string;
  readonly projectId: CodeProjectPullRequestRow["projectId"];
  readonly owner: string;
  readonly name: string;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
}

/** Groups keep the order their first row has in the (already sorted) list. */
export function groupPullRequestsByRepository(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
): ReadonlyArray<PullRequestRepositoryGroup> {
  const groups: Array<{
    key: string;
    projectId: CodeProjectPullRequestRow["projectId"];
    owner: string;
    name: string;
    rows: CodeProjectPullRequestRow[];
  }> = [];
  for (const row of rows) {
    const key = `${String(row.projectId)}:${repositoryName(row)}`;
    const existing = groups.find((group) => group.key === key);
    if (existing === undefined) {
      groups.push({
        key,
        projectId: row.projectId,
        owner: row.repositoryOwner,
        name: row.repositoryName,
        rows: [row],
      });
    } else {
      existing.rows.push(row);
    }
  }
  return groups;
}

/**
 * What is holding this pull request up, if anything.
 *
 * Every fact used to carry its own colour, so one row could show a red
 * "Checks failing", an amber "Review pending" and a green "Mergeable" at once
 * and contradict itself at a glance. Only the one that actually blocks the
 * merge is named and coloured.
 */
export function blockingFact(
  row: CodeProjectPullRequestRow,
): "mergeability" | "checks" | "review" | undefined {
  if (row.mergeability === "conflicting") return "mergeability";
  if (row.checks === "failing") return "checks";
  if (row.review === "changes-requested") return "review";
  if (row.checks === "pending") return "checks";
  if (row.review === "pending") return "review";
  return undefined;
}

export interface PullRequestAttention {
  readonly label: string;
  readonly tone: "negative" | "warning" | "neutral";
}

/**
 * The one thing a row's trailing edge says. A draft is not a candidate for the
 * merge whatever else is true of it, so it comes first.
 */
export function pullRequestAttention(
  row: CodeProjectPullRequestRow,
): PullRequestAttention | undefined {
  if (row.draft) return { label: "Draft", tone: "neutral" };
  const fact = blockingFact(row);
  if (fact === "mergeability") return { label: "Conflicts", tone: "negative" };
  if (fact === "checks") {
    return row.checks === "failing"
      ? { label: "Checks failing", tone: "negative" }
      : { label: "Checks pending", tone: "warning" };
  }
  if (fact === "review") {
    return row.review === "changes-requested"
      ? { label: "Changes requested", tone: "negative" }
      : { label: "Review pending", tone: "warning" };
  }
  return undefined;
}

export function reviewCopy(review: CodeProjectPullRequestRow["review"]): string {
  if (review === "changes-requested") return "changes requested";
  // The raw value reads as "Review none", which is not a sentence about a
  // pull request nobody has looked at yet.
  if (review === "none") return "not started";
  return review;
}

export function mergeabilityCopy(value: CodeProjectPullRequestRow["mergeability"]): string {
  if (value === "mergeable") return "Mergeable";
  if (value === "conflicting") return "Conflicts";
  return "Mergeability unknown";
}

/** Every fact the one-word summary leaves out, for a tooltip and for a screen reader. */
export function pullRequestStatusSentence(row: CodeProjectPullRequestRow): string {
  const parts = [
    ...(row.draft ? ["Draft"] : []),
    `Checks ${row.checks}`,
    `Review ${reviewCopy(row.review)}`,
    mergeabilityCopy(row.mergeability),
  ];
  return `${parts.join(". ")}.`;
}

/** "5m", "2h", "5d": the compact age of the row's meta line. */
export function compactAge(at: string, now: number = Date.now()): string {
  const label = relativeTimeLabel(at, now);
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}
