import type { GithubClient } from "@octant/client-runtime/github-client";
import type {
  GithubIssueRow,
  GithubIssueStateFilter,
  GithubRepositoryRow,
} from "@octant/contracts";
import { describeGithubRemediation } from "./githubRemediation";

/** An issue row that knows its repository, so a cross-repository list can attribute it. */
export interface RepositoryIssueRow extends GithubIssueRow {
  readonly owner: string;
  readonly name: string;
}

export interface RepositoryReadRefusal {
  readonly owner: string;
  readonly name: string;
  readonly message: string;
}

export interface IssuesAcrossRepositories {
  readonly rows: ReadonlyArray<RepositoryIssueRow>;
  /** Repositories whose first page could not be read, with the reason in words. */
  readonly refused: ReadonlyArray<RepositoryReadRefusal>;
  /** Repositories with more issues than one page holds; the list shows their newest page only. */
  readonly truncated: ReadonlyArray<string>;
  readonly stale: boolean;
}

export type IssueSort = "updated-desc" | "updated-asc" | "repository" | "number-desc";

export const ISSUE_SORT_OPTIONS: ReadonlyArray<{ readonly id: IssueSort; readonly label: string }> =
  [
    { id: "updated-desc", label: "Recently updated" },
    { id: "updated-asc", label: "Least recently updated" },
    { id: "number-desc", label: "Highest number" },
    { id: "repository", label: "Repository" },
  ];

/** Sorting by repository exists only across repositories; this one always does. */
export const DEFAULT_ISSUE_SORT: IssueSort = "updated-desc";

export function isIssueSort(value: string): value is IssueSort {
  return ISSUE_SORT_OPTIONS.some((option) => option.id === value);
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Reads the newest page of issues from each repository and merges them. The
 * catalogue only pages per repository, so "every issue across my
 * repositories" is a bounded snapshot: one page each, read a few at a time so
 * twenty recent repositories do not open twenty GitHub reads at once.
 */
export async function readIssuesAcrossRepositories(
  client: Pick<GithubClient, "readCatalogue">,
  repositories: ReadonlyArray<Pick<GithubRepositoryRow, "owner" | "name">>,
  options: {
    readonly state: GithubIssueStateFilter;
    readonly search?: string;
    readonly pageSize: number;
    readonly concurrency?: number;
    /** Narrows every repository read to issues nobody has been assigned. */
    readonly assignee?: "none";
  },
): Promise<IssuesAcrossRepositories> {
  const rows: RepositoryIssueRow[] = [];
  const refused: RepositoryReadRefusal[] = [];
  const truncated: string[] = [];
  let stale = false;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < repositories.length) {
      const repository = repositories[next++];
      if (repository === undefined) return;
      const label = `${repository.owner}/${repository.name}`;
      try {
        const response = await client.readCatalogue({
          kind: "issues",
          owner: repository.owner,
          name: repository.name,
          pageSize: options.pageSize,
          state: options.state,
          ...(options.search === undefined || options.search === ""
            ? {}
            : { search: options.search }),
          ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
        });
        if (response.kind === "unavailable") {
          refused.push({
            ...repository,
            message:
              response.remediation === undefined
                ? "GitHub refused the read."
                : describeGithubRemediation(response.remediation),
          });
          continue;
        }
        if (response.kind !== "issues") {
          refused.push({ ...repository, message: "GitHub returned an unexpected response." });
          continue;
        }
        for (const row of response.page.rows) {
          rows.push({ ...row, owner: repository.owner, name: repository.name });
        }
        if (response.page.hasNextPage) truncated.push(label);
        if (response.page.freshness.status === "stale") stale = true;
      } catch (error) {
        refused.push({
          ...repository,
          message: error instanceof Error ? error.message : "GitHub issues are unavailable.",
        });
      }
    }
  };

  const workers = Array.from(
    {
      length: Math.max(
        1,
        Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, repositories.length),
      ),
    },
    () => worker(),
  );
  await Promise.all(workers);
  return { rows, refused, truncated, stale };
}

export function sortIssueRows<Row extends RepositoryIssueRow>(
  rows: ReadonlyArray<Row>,
  sort: IssueSort,
): ReadonlyArray<Row> {
  // Concurrent reads append rows in whatever order the responses land, so two
  // issues sharing a timestamp would swap places between refreshes. Repository
  // and number settle every remaining tie.
  const byIdentity = (a: Row, b: Row) =>
    `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`) || a.number - b.number;
  const byUpdatedDesc = (a: Row, b: Row) =>
    b.updatedAt.localeCompare(a.updatedAt) || byIdentity(a, b);
  const sorted = [...rows];
  switch (sort) {
    case "updated-desc":
      return sorted.sort(byUpdatedDesc);
    case "updated-asc":
      return sorted.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || byIdentity(a, b));
    case "number-desc":
      return sorted.sort((a, b) => b.number - a.number || byUpdatedDesc(a, b));
    case "repository":
      return sorted.sort(
        (a, b) =>
          `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`) || byUpdatedDesc(a, b),
      );
  }
}
