import type {
  CodeProjectPullRequestChecksSummary,
  CodeProjectPullRequestRow,
  GithubAuthenticationSnapshot,
  GithubRepositoryName,
  GithubRepositoryOwner,
  ProjectId,
} from "@octant/contracts";
import { decideGithubCatalogueRead } from "@octant/domain";
import type { OctantMode } from "@octant/contracts/modes";

/** Rows the card lists before it says "+N more". */
export const PULL_REQUEST_CARD_ROW_LIMIT = 6;

export const PULL_REQUESTS_CARD_ID = "pull-requests";

/** What the checks summary says, in words. */
export type PullRequestCiState = "passed" | "failed" | "running" | "none";

/** What the review summary says, in words. Draft wins over a decision. */
export type PullRequestReviewState = "approved" | "changes requested" | "in review" | "draft";

export type PullRequestCardGroup = "waiting" | "yours";

export interface PullRequestCardRow {
  readonly key: string;
  readonly group: PullRequestCardGroup;
  readonly projectId: ProjectId;
  readonly repositoryOwner: GithubRepositoryOwner;
  readonly repositoryName: GithubRepositoryName;
  readonly number: number;
  readonly title: string;
  /** Short repository and number, such as `octant#12`. */
  readonly reference: string;
  readonly ci: PullRequestCiState;
  readonly review: PullRequestReviewState;
}

export interface PullRequestCardModel {
  readonly waiting: ReadonlyArray<PullRequestCardRow>;
  readonly yours: ReadonlyArray<PullRequestCardRow>;
  /** The first rows across both groups, waiting before yours. */
  readonly shown: ReadonlyArray<PullRequestCardRow>;
  readonly hidden: number;
  readonly total: number;
}

export interface PullRequestCardCapability {
  /** True when the same read the Pull requests destination uses is allowed. */
  readonly readable: boolean;
  readonly login?: string;
}

/**
 * Whether this window may offer the card. Hidden outside Code, when the
 * destination's plugin is off, and whenever that destination's read would be
 * refused — no connection, insecure token storage, or a missing capability.
 */
export function pullRequestCardCapability(
  snapshot: GithubAuthenticationSnapshot | undefined,
): PullRequestCardCapability {
  if (snapshot === undefined) return { readable: false };
  const decision = decideGithubCatalogueRead({
    capability: "pull-requests-read",
    snapshot,
  });
  const login = snapshot.account?.login;
  if (decision.decision !== "allow" || login === undefined) return { readable: false };
  return { readable: true, login };
}

export function pullRequestCardAvailable(input: {
  readonly mode: OctantMode;
  readonly pluginEffective: boolean;
  readonly capability: PullRequestCardCapability;
}): boolean {
  return (
    input.mode === "code" &&
    input.pluginEffective &&
    input.capability.readable &&
    input.capability.login !== undefined
  );
}

export function pullRequestCiState(
  checks: CodeProjectPullRequestChecksSummary,
): PullRequestCiState {
  if (checks === "passing") return "passed";
  if (checks === "failing") return "failed";
  if (checks === "pending") return "running";
  return "none";
}

export function pullRequestReviewState(
  row: Pick<CodeProjectPullRequestRow, "draft" | "review">,
): PullRequestReviewState {
  if (row.draft) return "draft";
  if (row.review === "approved") return "approved";
  if (row.review === "changes-requested") return "changes requested";
  return "in review";
}

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function askedToReview(row: CodeProjectPullRequestRow, viewerLogin: string): boolean {
  return (row.reviewRequestedFrom ?? []).some((login) => sameLogin(login, viewerLogin));
}

function cardRow(row: CodeProjectPullRequestRow, group: PullRequestCardGroup): PullRequestCardRow {
  return {
    key: `${String(row.projectId)}:${row.repositoryOwner}/${row.repositoryName}#${String(row.number)}`,
    group,
    projectId: row.projectId,
    repositoryOwner: row.repositoryOwner,
    repositoryName: row.repositoryName,
    number: row.number,
    title: row.title,
    reference: `${row.repositoryName}#${String(row.number)}`,
    ci: pullRequestCiState(row.checks),
    review: pullRequestReviewState(row),
  };
}

function byRecent(left: CodeProjectPullRequestRow, right: CodeProjectPullRequestRow): number {
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  return right.number - left.number;
}

/**
 * Waiting on your review, then yours, from one already-authorized list. A
 * pull request that is both is listed once, under waiting. Anything that is
 * neither is left out. At most six rows are shown.
 */
export function buildPullRequestCard(input: {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly viewerLogin: string;
}): PullRequestCardModel {
  const open = input.rows.filter((row) => row.state === "open");
  const waiting = open
    .filter((row) => askedToReview(row, input.viewerLogin))
    .toSorted(byRecent)
    .map((row) => cardRow(row, "waiting"));
  const yours = open
    .filter(
      (row) => sameLogin(row.author, input.viewerLogin) && !askedToReview(row, input.viewerLogin),
    )
    .toSorted(byRecent)
    .map((row) => cardRow(row, "yours"));
  const ordered = [...waiting, ...yours];
  const shown = ordered.slice(0, PULL_REQUEST_CARD_ROW_LIMIT);
  return {
    waiting: shown.filter((row) => row.group === "waiting"),
    yours: shown.filter((row) => row.group === "yours"),
    shown,
    hidden: ordered.length - shown.length,
    total: ordered.length,
  };
}
