/**
 * Which pull request guide writers the host may offer.
 *
 * Installation, trust, and enablement stay separate steps and each is a
 * precondition: a writer missing any of them is withheld and never invoked.
 * Discovery grants nothing. The decision is evaluated on every lookup, so
 * disabling or untrusting a plugin immediately withdraws its writer from
 * further runs. Two contributions that claim the same writer id are both
 * withheld rather than picking one.
 */
import {
  PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  type PullRequestGuideWriter,
} from "@octant/plugin-api/pull-request-guide-writer";

export interface PullRequestGuideWriterActivationFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly enabled: boolean;
}

export type PullRequestGuideWriterOffer =
  | { readonly status: "offered" }
  | {
      readonly status: "withheld";
      readonly reason: "not-installed" | "not-trusted" | "disabled";
    };

export function offerPullRequestGuideWriter(
  facts: PullRequestGuideWriterActivationFacts,
): PullRequestGuideWriterOffer {
  if (!facts.installed) return { status: "withheld", reason: "not-installed" };
  if (!facts.trusted) return { status: "withheld", reason: "not-trusted" };
  if (!facts.enabled) return { status: "withheld", reason: "disabled" };
  return { status: "offered" };
}

export interface PullRequestGuideWriterContribution {
  readonly writerId: string;
  readonly displayName: string;
  readonly facts: PullRequestGuideWriterActivationFacts;
  readonly writer: PullRequestGuideWriter;
}

export interface OfferedPullRequestGuideWriter {
  readonly writerId: string;
  readonly displayName: string;
  readonly writer: PullRequestGuideWriter;
}

/**
 * The pull request guide writers offered now, in id order. Two contributions
 * that claim one id are both withheld so a guide run never silently routes to
 * a different plugin.
 */
export function offeredPullRequestGuideWriters(
  contributions: ReadonlyArray<PullRequestGuideWriterContribution>,
): ReadonlyArray<OfferedPullRequestGuideWriter> {
  const claims = new Map<string, number>();
  for (const contribution of contributions) {
    claims.set(contribution.writerId, (claims.get(contribution.writerId) ?? 0) + 1);
  }
  return contributions
    .filter(
      (contribution) =>
        claims.get(contribution.writerId) === 1 &&
        contribution.writer.kind === PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND &&
        offerPullRequestGuideWriter(contribution.facts).status === "offered",
    )
    .map(({ writerId, displayName, writer }) => ({ writerId, displayName, writer }))
    .sort((left, right) => left.writerId.localeCompare(right.writerId));
}
