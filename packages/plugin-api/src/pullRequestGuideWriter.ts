/**
 * The pull request guide writer contribution seam.
 *
 * A guide writer turns one pushed head of a pull request into an ordered list
 * of stops for the person reading it, through the same narrow host port shape
 * as a pull request reviewer:
 * - read-only access to the host-verified diff snapshot at that head, and
 * - one host-enforced, read-only model turn at Plan's gate, on the model the
 *   person picked for guides, with its spend reserved by the host.
 *
 * A writer only proposes stops. The host enforces the limits (30 stops,
 * 8 anchors a stop, 16 KB of model output), drops every anchor that does not
 * point into the diff at the head, and journals the guide. A writer receives
 * no filesystem path, shell, credential or forge token.
 */
import type { PullRequestReviewTarget } from "@octant/contracts/pull-request-reviewer";
import type {
  PullRequestReviewDiffResult,
  PullRequestReviewTurnInput,
  PullRequestReviewTurnResult,
} from "./pullRequestReviewer";

export {
  MAX_PULL_REQUEST_GUIDE_ANCHORS,
  MAX_PULL_REQUEST_GUIDE_OUTPUT_BYTES,
  MAX_PULL_REQUEST_GUIDE_STOPS,
  MAX_PULL_REQUEST_GUIDE_TITLE_CHARS,
  MAX_PULL_REQUEST_GUIDE_WHY_BYTES,
} from "@octant/contracts/pull-request-guide";

export const PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND = "pull-request-guide-writer" as const;

/** The exact head a guide is written for. */
export interface PullRequestGuideWriteRequest {
  readonly target: PullRequestReviewTarget;
  readonly headSha: string;
  readonly baseRef: string;
}

/** One stop as a writer proposes it; the host validates every field. */
export interface PullRequestGuideStopProposal {
  readonly title: string;
  readonly why: string;
  readonly needsDecision: boolean;
  readonly anchors: ReadonlyArray<{
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

export type PullRequestGuideWriteOutcome =
  | { readonly status: "written"; readonly stops: ReadonlyArray<PullRequestGuideStopProposal> }
  | { readonly status: "stale" }
  | { readonly status: "invalid-output"; readonly detail: string }
  | { readonly status: "refused"; readonly detail: string }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly detail: string };

/** Capability-scoped host port for one guide run on one head. */
export interface PullRequestGuideHostPort {
  readonly readPullRequestDiff: (signal?: AbortSignal) => Promise<PullRequestReviewDiffResult>;
  readonly runReadOnlyGuideTurn: (
    input: PullRequestReviewTurnInput,
    signal?: AbortSignal,
  ) => Promise<PullRequestReviewTurnResult>;
}

/** A pull request guide writer plugin contribution. */
export interface PullRequestGuideWriter {
  readonly kind: typeof PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND;
  readonly write: (
    request: PullRequestGuideWriteRequest,
    host: PullRequestGuideHostPort,
    signal: AbortSignal,
  ) => Promise<PullRequestGuideWriteOutcome>;
}
