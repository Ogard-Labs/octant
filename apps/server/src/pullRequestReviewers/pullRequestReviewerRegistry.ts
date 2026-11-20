import {
  PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND,
  decodePullRequestReviewOutcome,
  decodePullRequestReviewRequest,
  type PullRequestReviewOutcome,
  type PullRequestReviewRequest,
  type PullRequestReviewer,
  type PullRequestReviewerId,
} from "@octant/plugin-api/pull-request-reviewer";
import {
  offeredPullRequestReviewers,
  type OfferedPullRequestReviewer,
  type PullRequestReviewerActivationFacts,
} from "@octant/plugin-host/pull-request-reviewers";
import {
  createPullRequestReviewHostPort,
  type PullRequestReviewHostDelegates,
} from "./pullRequestReviewHostPort";

export interface PullRequestReviewerRegistration {
  readonly reviewerId: PullRequestReviewerId;
  readonly displayName: string;
  /** Evaluated live on every lookup and mid-run check so disabling takes effect at once. */
  readonly activation: () => PullRequestReviewerActivationFacts;
  readonly reviewer: PullRequestReviewer;
}

export type PullRequestReviewerRegisterResult =
  | { readonly kind: "registered"; readonly release: () => void }
  | { readonly kind: "refused" };

export interface RunPullRequestReviewerInput {
  readonly reviewerId: PullRequestReviewerId;
  readonly request: PullRequestReviewRequest;
  readonly signal: AbortSignal;
  readonly delegates: Omit<PullRequestReviewHostDelegates, "effective"> & {
    readonly effective?: () => boolean;
  };
}

const GIT_OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/**
 * Host registry for pull request reviewer plugin contributions.
 *
 * Every listing and invocation passes through `@octant/plugin-host`'s pure
 * activation and collision policy (`offeredPullRequestReviewers`). A reviewer
 * runs with a scoped `PullRequestReviewHostPort`, and the registry enforces the
 * final effectiveness, head-staleness, and outcome-validation fences so a
 * stale or inactive review is never reported as current.
 */
export class PullRequestReviewerRegistry {
  readonly #registrations: Array<{
    readonly identity: object;
    readonly entry: PullRequestReviewerRegistration;
  }> = [];

  register(entry: PullRequestReviewerRegistration): PullRequestReviewerRegisterResult {
    if (entry.reviewer.kind !== PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND) {
      return { kind: "refused" };
    }
    const identity = {};
    this.#registrations.push({ identity, entry });
    return {
      kind: "registered",
      release: () => {
        const index = this.#registrations.findIndex((record) => record.identity === identity);
        if (index !== -1) this.#registrations.splice(index, 1);
      },
    };
  }

  /** Currently offered reviewers (installed, trusted, enabled, and non-colliding). */
  list(): ReadonlyArray<OfferedPullRequestReviewer> {
    return offeredPullRequestReviewers(
      this.#registrations.map(({ entry }) => ({
        reviewerId: entry.reviewerId,
        displayName: entry.displayName,
        facts: entry.activation(),
        reviewer: entry.reviewer,
      })),
    );
  }

  has(reviewerId: PullRequestReviewerId): boolean {
    const key = String(reviewerId);
    return this.list().some((entry) => String(entry.reviewerId) === key);
  }

  async run(input: RunPullRequestReviewerInput): Promise<PullRequestReviewOutcome> {
    let request: PullRequestReviewRequest;
    try {
      request = decodePullRequestReviewRequest(input.request);
    } catch {
      return {
        status: "failed",
        detail: "The pull request review request failed strict contract validation.",
      };
    }

    const offered = this.list().find(
      (entry) => String(entry.reviewerId) === String(input.reviewerId),
    );
    const isEffective = () => this.has(input.reviewerId) && (input.delegates.effective?.() ?? true);

    if (offered === undefined || !isEffective()) {
      return {
        status: "refused",
        reason: "not-effective",
        detail: "The selected pull request reviewer is not active.",
      };
    }

    if (input.signal.aborted) {
      return { status: "cancelled" };
    }

    const initialHead = await safeReadHead(input.delegates.readCurrentHeadSha, input.signal);
    if (initialHead !== request.headSha) {
      return staleOutcome(initialHead);
    }

    const session = createPullRequestReviewHostPort({
      request,
      signal: input.signal,
      delegates: {
        ...input.delegates,
        effective: isEffective,
      },
    });

    let rawOutcome: PullRequestReviewOutcome;
    try {
      rawOutcome = await offered.reviewer.review(request, session.port, input.signal);
    } catch {
      if (input.signal.aborted) return { status: "cancelled" };
      return {
        status: "failed",
        detail: "The pull request reviewer failed before completing its review.",
      };
    }

    if (session.observedIneffective() || !isEffective()) {
      return {
        status: "refused",
        reason: "not-effective",
        detail: "The pull request reviewer became inactive before completing its review.",
      };
    }

    const stale = session.observedStale();
    if (stale.stale) {
      return staleOutcome(stale.currentHeadSha);
    }

    if (input.signal.aborted) {
      return { status: "cancelled" };
    }

    const finalHead = await safeReadHead(input.delegates.readCurrentHeadSha, input.signal);
    if (finalHead !== request.headSha) {
      return staleOutcome(finalHead);
    }

    let decoded: PullRequestReviewOutcome;
    try {
      decoded = decodePullRequestReviewOutcome(rawOutcome);
    } catch {
      return {
        status: "failed",
        detail: "The pull request reviewer returned an invalid outcome.",
      };
    }

    if (decoded.status !== "completed") {
      return decoded;
    }

    // Never trust a plugin's self-reported finding ids, run id, comment flag,
    // or hand-back flag over the host's own recorded session truth.
    const recordedIds = new Set(session.recordedFindings().map((finding) => String(finding.id)));
    if (decoded.findingIds.some((id) => !recordedIds.has(String(id)))) {
      return {
        status: "failed",
        detail: "The pull request reviewer reported findings that were not recorded by the host.",
      };
    }
    if (decoded.runId !== undefined && !session.completedTurnIds().has(String(decoded.runId))) {
      return {
        status: "failed",
        detail: "The pull request reviewer cited a review turn not recorded by the host.",
      };
    }

    return decodePullRequestReviewOutcome({
      status: "completed",
      findingIds: decoded.findingIds,
      ...(decoded.runId === undefined ? {} : { runId: decoded.runId }),
      summaryCommentPosted: session.summaryCommentPosted(),
      handedBackToWorker: session.handedBackToWorker(),
    });
  }
}

async function safeReadHead(
  reader: (signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return await reader(signal);
  } catch {
    return undefined;
  }
}

function staleOutcome(currentHeadSha: string | undefined): PullRequestReviewOutcome {
  if (currentHeadSha !== undefined && GIT_OBJECT_ID_PATTERN.test(currentHeadSha)) {
    return { status: "stale", currentHeadSha };
  }
  return { status: "stale" };
}
