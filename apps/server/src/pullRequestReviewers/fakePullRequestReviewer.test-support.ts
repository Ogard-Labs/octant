import type {
  PullRequestReviewHostPort,
  PullRequestReviewOutcome,
  PullRequestReviewRequest,
  PullRequestReviewer,
} from "@octant/plugin-api/pull-request-reviewer";

/**
 * In-memory pull request reviewer for tests only. Records every request and
 * delegates its review body to a scripted callback so tests can prove every
 * host-port invariant without coupling to a concrete reviewer plugin.
 */
export function fakePullRequestReviewer(
  run: (
    request: PullRequestReviewRequest,
    host: PullRequestReviewHostPort,
    signal: AbortSignal,
  ) => Promise<PullRequestReviewOutcome>,
): {
  readonly reviewer: PullRequestReviewer;
  readonly calls: Array<PullRequestReviewRequest>;
} {
  const calls: Array<PullRequestReviewRequest> = [];
  const reviewer: PullRequestReviewer = {
    kind: "pull-request-reviewer",
    review: async (request, host, signal) => {
      calls.push(request);
      return run(request, host, signal);
    },
  };
  return { reviewer, calls };
}
