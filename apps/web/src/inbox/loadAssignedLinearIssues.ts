import type { LinearIssueListPage, LinearIssueRow } from "@octant/contracts/linear-issues";

/** Matches the inbox glance page size the host already accepts. */
export const ASSIGNED_LINEAR_PAGE_SIZE = 50;

/** Safety cap so a large backlog cannot stall the inbox on first open. */
export const ASSIGNED_LINEAR_MAX_PAGES = 10;

/** Maximum rows the inbox loader may aggregate; not a wire-contract page. */
export const ASSIGNED_LINEAR_MAX_ROWS = ASSIGNED_LINEAR_PAGE_SIZE * ASSIGNED_LINEAR_MAX_PAGES;

/**
 * A Linear issue row displayed in merged multi-account views (Inbox, Home).
 * Carries optional `accountRef` and `workspaceLabel` when multiple Linear
 * accounts are connected so the user can tell workspaces apart and picking an
 * issue binds to the right account.
 */
export interface AssignedLinearIssueRow extends LinearIssueRow {
  readonly accountRef?: string;
  readonly workspaceLabel?: string;
  readonly isLegacyAccount?: boolean;
}

/**
 * Inbox-local aggregate of assigned Linear issues. Unlike
 * `LinearIssueListPage`, this may hold up to {@link ASSIGNED_LINEAR_MAX_ROWS}
 * rows because the inbox pages through several host responses.
 */
export interface AssignedLinearIssuesList {
  readonly rows: ReadonlyArray<AssignedLinearIssueRow>;
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

export interface LinearAssignedAccountSource {
  readonly accountRef: string;
  readonly workspaceLabel: string;
  readonly isLegacy?: boolean;
}

/**
 * Loads every assigned issue the inbox can reasonably show, paging until the
 * host reports no further page or the safety cap is reached. When the cap
 * bites, `truncated` and `hasNextPage` stay true so the view can say the list
 * is incomplete.
 */
export async function loadAssignedLinearIssues(
  listIssues: ListAssignedLinearIssues,
): Promise<AssignedLinearIssuesList> {
  const rows: AssignedLinearIssueRow[] = [];
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

/**
 * Merges assigned Linear issues across multiple connected accounts, annotating
 * each row with its account reference and workspace label when more than one
 * account is connected. If one account fails while another succeeds, the
 * healthy account's rows are still returned.
 */
export async function loadAssignedLinearIssuesAcrossAccounts(
  accounts: ReadonlyArray<LinearAssignedAccountSource>,
  listIssuesForAccount: (
    input: {
      readonly filter: { readonly assigneeId: "me" };
      readonly pageSize: number;
      readonly cursor?: string;
    },
    accountRef: string,
  ) => Promise<LinearIssueListPage>,
): Promise<AssignedLinearIssuesList> {
  if (accounts.length === 0) {
    return { rows: [], hasNextPage: false, truncated: false };
  }
  const showWorkspace = accounts.length > 1;
  const settled = await Promise.allSettled(
    accounts.map(async (account): Promise<AssignedLinearIssuesList> => {
      const page = await loadAssignedLinearIssues((input) =>
        listIssuesForAccount(input, account.accountRef),
      );
      return {
        ...page,
        rows: page.rows.map(
          (row): AssignedLinearIssueRow => ({
            ...row,
            accountRef: account.accountRef,
            ...(showWorkspace ? { workspaceLabel: account.workspaceLabel } : {}),
            ...(account.isLegacy === true ? { isLegacyAccount: true } : {}),
          }),
        ),
      };
    }),
  );
  const fulfilled = settled.filter(
    (entry): entry is PromiseFulfilledResult<AssignedLinearIssuesList> =>
      entry.status === "fulfilled",
  );
  if (fulfilled.length === 0) {
    const firstRejected = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    throw firstRejected?.reason ?? new Error("Linear could not be reached.");
  }
  return {
    rows: fulfilled.flatMap((entry) => entry.value.rows),
    hasNextPage: fulfilled.some((entry) => entry.value.hasNextPage),
    truncated: fulfilled.some((entry) => entry.value.truncated),
  };
}
