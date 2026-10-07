import type { CodeCheckoutIdentity, CodeThread } from "@octant/contracts/code";
import type {
  CodeProjectPullRequestRow,
  GithubRepositoryName,
  GithubRepositoryOwner,
  ProjectId,
} from "@octant/contracts";
import { buildCiFailureFollowUpDraft } from "@octant/domain/code-follow-up-policy";

/** Rows the card lists. Further failures stay off the start screen. */
export const CI_FAILURES_CARD_ROW_LIMIT = 5;

export const CI_FAILURES_CARD_ID = "ci-failures";

export interface CodeProjectCurrentBranch {
  readonly projectId: ProjectId;
  readonly branch: string;
}

export interface CiFailureCardRow {
  readonly key: string;
  readonly checkName: string;
  /** The repository and number, or the branch when the failure is only on a checkout. */
  readonly place: string;
  /** When the check finished failing. Absent when the refresh did not record it. */
  readonly failedAt?: string;
  readonly projectId: ProjectId;
  readonly repositoryOwner: GithubRepositoryOwner;
  readonly repositoryName: GithubRepositoryName;
  readonly branch: string;
  /** The draft text. Opening it does not send a turn. */
  readonly prompt: string;
}

/**
 * Branches the window already knows a Code Project is on: an active thread's
 * available checkout. Archived threads and a checkout the host cannot see are
 * not current.
 */
export function currentCodeProjectBranches(input: {
  readonly threads: ReadonlyArray<Pick<CodeThread, "projectId" | "checkoutId" | "lifecycle">>;
  readonly checkouts: ReadonlyArray<Pick<CodeCheckoutIdentity, "id" | "availability" | "head">>;
}): ReadonlyArray<CodeProjectCurrentBranch> {
  const checkouts = new Map(input.checkouts.map((checkout) => [String(checkout.id), checkout]));
  const seen = new Set<string>();
  const branches: CodeProjectCurrentBranch[] = [];
  for (const thread of input.threads) {
    if (thread.lifecycle !== "active") continue;
    const checkout = checkouts.get(String(thread.checkoutId));
    if (checkout === undefined || checkout.availability !== "available") continue;
    if (checkout.head.kind !== "branch") continue;
    const branch = checkout.head.name;
    const key = `${String(thread.projectId)}:${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push({ projectId: thread.projectId, branch });
  }
  return branches;
}

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function onCurrentBranch(
  row: CodeProjectPullRequestRow,
  branches: ReadonlyArray<CodeProjectCurrentBranch>,
): boolean {
  return branches.some(
    (branch) =>
      String(branch.projectId) === String(row.projectId) && branch.branch === row.headBranch,
  );
}

function byRecentFailure(left: CiFailureCardRow, right: CiFailureCardRow): number {
  const leftAt = left.failedAt ?? "";
  const rightAt = right.failedAt ?? "";
  if (leftAt !== rightAt) {
    if (leftAt === "") return 1;
    if (rightAt === "") return -1;
    return rightAt.localeCompare(leftAt);
  }
  const byName = left.checkName.localeCompare(right.checkName);
  if (byName !== 0) return byName;
  return left.place.localeCompare(right.place);
}

/**
 * Failing checks the pull-request refresh already recorded, on the person's
 * open pull requests and on the current branches of Code Projects. A pull
 * request that is neither is left out. At most five rows, most recently
 * failed first.
 */
export function buildCiFailureCard(input: {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly viewerLogin: string;
  readonly currentBranches: ReadonlyArray<CodeProjectCurrentBranch>;
}): { readonly rows: ReadonlyArray<CiFailureCardRow> } {
  const listed: CiFailureCardRow[] = [];
  for (const row of input.rows) {
    if (row.state !== "open") continue;
    const checks = row.failingChecks;
    if (checks === undefined || checks.length === 0) continue;
    const yours = sameLogin(row.author, input.viewerLogin);
    const current = onCurrentBranch(row, input.currentBranches);
    if (!yours && !current) continue;
    const place = yours ? `${row.repositoryName}#${String(row.number)}` : row.headBranch;
    checks.forEach((check, index) => {
      listed.push({
        key: `${String(row.projectId)}:${row.repositoryOwner}/${row.repositoryName}#${String(row.number)}:${check.name}:${String(index)}`,
        checkName: check.name,
        place,
        ...(check.completedAt === undefined ? {} : { failedAt: check.completedAt }),
        projectId: row.projectId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        branch: row.headBranch,
        prompt: buildCiFailureFollowUpDraft({
          number: row.number,
          title: row.title,
          checkName: check.name,
          branch: row.headBranch,
          repository: `${row.repositoryOwner}/${row.repositoryName}`,
        }),
      });
    });
  }
  return { rows: listed.toSorted(byRecentFailure).slice(0, CI_FAILURES_CARD_ROW_LIMIT) };
}
