/**
 * Which pull request reviewers the host may offer.
 *
 * Installation, trust, and enablement stay separate steps and each is a
 * precondition: a reviewer missing any of them is withheld and never invoked.
 * The decision is evaluated on every lookup, so disabling or untrusting a
 * plugin immediately withdraws its reviewer from further runs. Two
 * contributions that claim the same reviewer id are both withheld rather than
 * picking one.
 */
import {
  PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND,
  type PullRequestReviewer,
  type PullRequestReviewerId,
} from "@octant/plugin-api/pull-request-reviewer";

export interface PullRequestReviewerActivationFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly enabled: boolean;
}

export type PullRequestReviewerOffer =
  | { readonly status: "offered" }
  | {
      readonly status: "withheld";
      readonly reason: "not-installed" | "not-trusted" | "disabled";
    };

export function offerPullRequestReviewer(
  facts: PullRequestReviewerActivationFacts,
): PullRequestReviewerOffer {
  if (!facts.installed) return { status: "withheld", reason: "not-installed" };
  if (!facts.trusted) return { status: "withheld", reason: "not-trusted" };
  if (!facts.enabled) return { status: "withheld", reason: "disabled" };
  return { status: "offered" };
}

export interface PullRequestReviewerContribution {
  readonly reviewerId: PullRequestReviewerId;
  readonly displayName: string;
  readonly facts: PullRequestReviewerActivationFacts;
  readonly reviewer: PullRequestReviewer;
}

export interface OfferedPullRequestReviewer {
  readonly reviewerId: PullRequestReviewerId;
  readonly displayName: string;
  readonly reviewer: PullRequestReviewer;
}

/**
 * The pull request reviewers offered now, in id order. Two contributions that
 * claim one id are both withheld so a Project or thread choice never silently
 * routes to a different plugin.
 */
export function offeredPullRequestReviewers(
  contributions: ReadonlyArray<PullRequestReviewerContribution>,
): ReadonlyArray<OfferedPullRequestReviewer> {
  const claims = new Map<string, number>();
  for (const contribution of contributions) {
    const key = String(contribution.reviewerId);
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  return contributions
    .filter(
      (contribution) =>
        claims.get(String(contribution.reviewerId)) === 1 &&
        contribution.reviewer.kind === PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND &&
        offerPullRequestReviewer(contribution.facts).status === "offered",
    )
    .map(({ reviewerId, displayName, reviewer }) => ({ reviewerId, displayName, reviewer }))
    .sort((left, right) => String(left.reviewerId).localeCompare(String(right.reviewerId)));
}
