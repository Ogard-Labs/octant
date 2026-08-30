import type { LinearIssueListPage, LinearIssueRow } from "@octant/contracts/linear-issues";

/** Matches the inbox glance page size the host already accepts. */
export const ASSIGNED_LINEAR_PAGE_SIZE = 50;

/** Safety cap so a large backlog cannot stall the inbox on first open. */
export const ASSIGNED_LINEAR_MAX_PAGES = 10;

export type ListAssignedLinearIssues = (input: {
  readonly filter: { readonly assigneeId: "me" };
  readonly pageSize: number;
  readonly cursor?: string;
}) => Promise<LinearIssueListPage>;

/**
 * Loads every assigned issue the inbox can reasonably show, paging until the
 * host reports no further page or the safety cap is reached. When the cap
 * bites, `hasNextPage` stays true so the view can say the list is incomplete.
 */
export async function loadAssignedLinearIssues(
  listIssues: ListAssignedLinearIssues,
): Promise<LinearIssueListPage> {
  const rows: LinearIssueRow[] = [];
  let cursor: string | undefined;
  let hasNextPage = true;

  for (let pageIndex = 0; pageIndex < ASSIGNED_LINEAR_MAX_PAGES && hasNextPage; pageIndex += 1) {
    const page = await listIssues({
      filter: { assigneeId: "me" },
      pageSize: ASSIGNED_LINEAR_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
  }

  return {
    rows,
    hasNextPage,
    ...(hasNextPage && cursor !== undefined ? { endCursor: cursor } : {}),
  };
}
