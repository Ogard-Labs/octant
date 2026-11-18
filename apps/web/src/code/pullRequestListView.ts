import type { CodeProjectPullRequestRow } from "@octant/contracts";

/**
 * The page's ordering and narrowing of the cached rows. The rows carry the time
 * of the last update and no creation time, so the orders offered are the ones
 * the row's own age can answer.
 */
export type PullRequestSort = "updated" | "stalest" | "repository";
export type PullRequestStateFilter = "any" | "open" | "draft";
export type PullRequestReviewFilter = "any" | "approved" | "changes-requested" | "needs-review";
export type PullRequestChecksFilter = "any" | "passing" | "failing" | "pending";

export type PullRequestInvolvementFilter = "any" | "involving-me" | "review-requested" | "authored";

export interface PullRequestFilters {
  readonly state: PullRequestStateFilter;
  readonly involvement: PullRequestInvolvementFilter;
  readonly review: PullRequestReviewFilter;
  readonly checks: PullRequestChecksFilter;
}

export const NO_PULL_REQUEST_FILTERS: PullRequestFilters = {
  state: "any",
  involvement: "any",
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

/**
 * Who a pull request involves. The rows know the author and who was asked to
 * review, so those are the questions the list can answer; assignees and
 * labels are not on a row and are not offered.
 */
export const PULL_REQUEST_INVOLVEMENT_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestInvolvementFilter;
  readonly label: string;
}> = [
  { value: "any", label: "Anyone" },
  { value: "involving-me", label: "Involving me" },
  { value: "review-requested", label: "Review requested" },
  { value: "authored", label: "Authored by me" },
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
    (filters.involvement === "any" ? 0 : 1) +
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

/** The name the Repository control lists and the window remembers. */
export const pullRequestRepository = repositoryName;

export interface PullRequestRepositoryOption {
  readonly key: string;
  readonly count: number;
}

/**
 * Every repository the rows span with how many rows each holds, in name order.
 * The count is of the rows handed in, so the menu says what choosing a
 * repository alone would leave in the list under the other choices.
 */
export function repositoryOptions(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
  known: ReadonlyArray<string> = [],
): ReadonlyArray<PullRequestRepositoryOption> {
  const counts = new Map<string, number>(known.map((key) => [key, 0]));
  for (const row of rows)
    counts.set(repositoryName(row), (counts.get(repositoryName(row)) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));
}

/** No choice is all repositories: an empty selection narrows nothing. */
export function filterByRepositories(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
  repositories: ReadonlyArray<string>,
): ReadonlyArray<CodeProjectPullRequestRow> {
  if (repositories.length === 0) return rows;
  return rows.filter((row) => repositories.includes(repositoryName(row)));
}

/** The words the filters on the list are named by, for an empty list to say what is narrowing it. */
export function activeFilterNames(
  filters: PullRequestFilters,
  repositories: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const label = (
    options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
    value: string,
  ) => options.find((option) => option.value === value)?.label ?? value;
  return [
    ...(filters.state === "any" ? [] : [label(PULL_REQUEST_STATE_OPTIONS, filters.state)]),
    ...(filters.involvement === "any"
      ? []
      : [label(PULL_REQUEST_INVOLVEMENT_OPTIONS, filters.involvement)]),
    ...(filters.review === "any" ? [] : [label(PULL_REQUEST_REVIEW_OPTIONS, filters.review)]),
    ...(filters.checks === "any" ? [] : [label(PULL_REQUEST_CHECKS_OPTIONS, filters.checks)]),
    ...(repositories.length === 0
      ? []
      : [
          repositories.length === 1
            ? (repositories[0] ?? "")
            : `${String(repositories.length)} repositories`,
        ]),
  ];
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

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function filterPullRequests(
  rows: ReadonlyArray<CodeProjectPullRequestRow>,
  filters: PullRequestFilters,
  /** The signed-in GitHub login; without it the involvement choice narrows nothing. */
  viewerLogin?: string,
): ReadonlyArray<CodeProjectPullRequestRow> {
  return rows.filter((row) => {
    if (filters.involvement !== "any" && viewerLogin !== undefined && viewerLogin !== "") {
      const authored = sameLogin(row.author, viewerLogin);
      const asked = (row.reviewRequestedFrom ?? []).some((login) => sameLogin(login, viewerLogin));
      if (filters.involvement === "authored" && !authored) return false;
      if (filters.involvement === "review-requested" && !asked) return false;
      if (filters.involvement === "involving-me" && !authored && !asked) return false;
    }
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
