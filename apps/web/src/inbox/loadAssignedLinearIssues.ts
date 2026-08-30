import type { LinearIssueListPage, LinearIssueRow } from "@octant/contracts/linear-issues";

/** Matches the inbox glance page size the host already accepts. */
export const ASSIGNED_LINEAR_PAGE_SIZE = 50;

/** Safety cap so a large backlog cannot stall the inbox on first open. */
export const ASSIGNED_LINEAR_MAX_PAGES = 10;

/** Maximum rows the inbox loader may aggregate; not a wire-contract page. */
export const ASSIGNED_LINEAR_MAX_ROWS = ASSIGNED_LINEAR_PAGE_SIZE * ASSIGNED_LINEAR_MAX_PAGES;

/**
 * Inbox-local aggregate of assigned Linear issues. Unlike
 * `LinearIssueListPage`, this may hold up to {@link ASSIGNED_LINEAR_MAX_ROWS}
 * rows because the inbox pages through several host responses.
 */
export interface AssignedLinearIssuesList {
  readonly rows: ReadonlyArray<LinearIssueRow>;
  readonly hasNextPage: boolean;
  /** True when aggregation stopped at the safety cap while the host still has more. */
  readonly truncated: boolean;
  readonly endCursor?: string;
}

export type ListAssignedLinearIssues = (input: {
  readonly filter: { readonly assigneeId: "me" };
  readonly pageSize: number;
  readonly cursor?: string;
}) => Promise<LinearIssueListPage>;

/**
 * Loads every assigned issue the inbox can reasonably show, paging until the
 * host reports no further page or the safety cap is reached. When the cap
 * bites, `truncated` and `hasNextPage` stay true so the view can say the list
 * is incomplete.
 */
export async function loadAssignedLinearIssues(
  listIssues: ListAssignedLinearIssues,
): Promise<AssignedLinearIssuesList> {
  const rows: LinearIssueRow[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;
  let pagesFetched = 0;

  for (let pageIndex = 0; pageIndex < ASSIGNED_LINEAR_MAX_PAGES && hasNextPage; pageIndex += 1) {
    const page = await listIssues({
      filter: { assigneeId: "me" },
      pageSize: ASSIGNED_LINEAR_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pagesFetched += 1;
    rows.push(...page.rows);
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
  }

  const truncated = hasNextPage && pagesFetched >= ASSIGNED_LINEAR_MAX_PAGES;

  return {
    rows,
    hasNextPage,
    truncated,
    ...(hasNextPage && cursor !== undefined ? { endCursor: cursor } : {}),
  };
}
