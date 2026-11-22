import {
  MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES,
  MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN,
  MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES,
  decodePullRequestReviewFindingProposal,
  type AgentRunId,
  type CodeReviewFinding,
  type ProviderInstanceId,
  type ProviderModelId,
  type PullRequestReviewDiffResult,
  type PullRequestReviewFindingProposal,
  type PullRequestReviewHandBackResult,
  type PullRequestReviewHostPort,
  type PullRequestReviewRecordFindingsResult,
  type PullRequestReviewRequest,
  type PullRequestReviewSummaryCommentResult,
  type PullRequestReviewTurnInput,
  type PullRequestReviewTurnResult,
} from "@octant/plugin-api/pull-request-reviewer";

const encoder = new TextEncoder();

/** Host-recorded receipt of a read-only child review turn completed within this review run. */
export interface PullRequestReviewTurnReceipt {
  readonly runId: AgentRunId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly sessionId: string;
}

/** Host-side delegates backing one scoped `PullRequestReviewHostPort`. */
export interface PullRequestReviewHostDelegates {
  /** Re-evaluated before and after every await; false withdraws authority immediately. */
  readonly effective: () => boolean;
  /** Reads the PR's current head SHA; `undefined` or a different SHA marks the review stale. */
  readonly readCurrentHeadSha: (signal: AbortSignal) => Promise<string | undefined>;
  readonly readPullRequestDiff?: (signal: AbortSignal) => Promise<PullRequestReviewDiffResult>;
  readonly runReadOnlyReviewTurn?: (
    input: PullRequestReviewTurnInput,
    signal: AbortSignal,
  ) => Promise<PullRequestReviewTurnResult>;
  readonly recordFindings?: (
    input: {
      readonly proposals: ReadonlyArray<PullRequestReviewFindingProposal>;
      readonly runReceipt?: PullRequestReviewTurnReceipt;
    },
    signal: AbortSignal,
  ) => Promise<PullRequestReviewRecordFindingsResult>;
  /** Host-enforced per-Project opt-in for posting one PR summary comment; off by default. */
  readonly isPostSummaryCommentEnabled?: () => boolean;
  readonly postSummaryComment?: (
    input: { readonly body: string },
    signal: AbortSignal,
  ) => Promise<PullRequestReviewSummaryCommentResult>;
  /** Host-enforced per-PR opt-in for waking the worker with blocking findings; off by default. */
  readonly isSendBlockingFindingsEnabled?: () => boolean;
  readonly handBackBlockingFindings?: (
    input: { readonly findings: ReadonlyArray<CodeReviewFinding> },
    signal: AbortSignal,
  ) => Promise<PullRequestReviewHandBackResult>;
}

export interface PullRequestReviewHostSession {
  readonly port: PullRequestReviewHostPort;
  /** Revokes the port once the review invocation settles so retained handles cannot act later. */
  readonly revoke: () => void;
  readonly observedStale: () => { readonly stale: boolean; readonly currentHeadSha?: string };
  readonly observedIneffective: () => boolean;
  readonly recordedFindings: () => ReadonlyArray<CodeReviewFinding>;
  readonly summaryCommentPosted: () => boolean;
  readonly handedBackToWorker: () => boolean;
  readonly completedTurnIds: () => ReadonlySet<string>;
}

const GIT_OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function combineSignals(root: AbortSignal, call?: AbortSignal): AbortSignal {
  if (call === undefined || call === root) return root;
  return AbortSignal.any([root, call]);
}

function validBoundedNonEmpty(value: string, maximumBytes: number): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !value.includes("\u0000") &&
    encoder.encode(value).byteLength <= maximumBytes
  );
}

/**
 * Creates the capability-scoped host port handed to one pull request reviewer
 * invocation. Every call re-checks plugin effectiveness, opt-in state,
 * cancellation, and PR head currency before and after awaiting, synchronously
 * reserves finding/comment/hand-back slots before the first await, verifies run
 * and finding ownership against host receipts, and latches staleness on every
 * stale or unreadable head path.
 */
export function createPullRequestReviewHostPort(options: {
  readonly request: PullRequestReviewRequest;
  readonly signal: AbortSignal;
  readonly delegates: PullRequestReviewHostDelegates;
}): PullRequestReviewHostSession {
  const { request, signal: rootSignal, delegates } = options;
  const completedTurns = new Map<string, PullRequestReviewTurnReceipt>();
  const recordedFindings = new Map<string, CodeReviewFinding>();
  let pendingFindingsCount = 0;
  let staleObserved = false;
  let staleHeadSha: string | undefined;
  let ineffectiveObserved = false;
  let revoked = false;
  let summaryCommentPosted = false;
  let summaryCommentInFlight = false;
  let handedBackToWorker = false;
  let handBackInFlight = false;

  const markStale = (currentHeadSha?: string): void => {
    staleObserved = true;
    if (currentHeadSha !== undefined && GIT_OBJECT_ID_PATTERN.test(currentHeadSha)) {
      staleHeadSha = currentHeadSha;
    }
  };

  const checkEffective = (): boolean => {
    if (revoked) return false;
    if (ineffectiveObserved || !delegates.effective()) {
      ineffectiveObserved = true;
      return false;
    }
    return true;
  };

  const checkHead = async (
    signal: AbortSignal,
  ): Promise<
    { readonly current: true } | { readonly current: false; readonly currentHeadSha?: string }
  > => {
    if (staleObserved) {
      return staleHeadSha === undefined
        ? { current: false }
        : { current: false, currentHeadSha: staleHeadSha };
    }
    let currentSha: string | undefined;
    try {
      currentSha = await delegates.readCurrentHeadSha(signal);
    } catch {
      if (!signal.aborted) markStale();
      return { current: false };
    }
    if (signal.aborted) {
      return { current: false };
    }
    if (currentSha === request.headSha) return { current: true };
    markStale(currentSha);
    return staleHeadSha === undefined
      ? { current: false }
      : { current: false, currentHeadSha: staleHeadSha };
  };

  const staleAnswer = (currentHeadSha?: string) =>
    currentHeadSha === undefined
      ? { status: "stale" as const }
      : { status: "stale" as const, currentHeadSha };

  const port: PullRequestReviewHostPort = {
    isHeadCurrent: async (callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective() || signal.aborted) return false;
      const head = await checkHead(signal);
      if (!checkEffective() || signal.aborted) return false;
      return head.current;
    },

    readPullRequestDiff: async (callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective()) return { status: "unavailable", reason: "not-effective" };
      if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
      const before = await checkHead(signal);
      if (!checkEffective()) return { status: "unavailable", reason: "not-effective" };
      if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
      if (!before.current) return staleAnswer(before.currentHeadSha);
      if (delegates.readPullRequestDiff === undefined) {
        return { status: "unavailable", reason: "unavailable" };
      }
      const result = await delegates.readPullRequestDiff(signal);
      if (!checkEffective()) return { status: "unavailable", reason: "not-effective" };
      if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
      if (result.status === "stale") {
        markStale(result.currentHeadSha);
        return staleAnswer(staleHeadSha);
      }
      if (result.status === "ready" && result.diff.headSha !== request.headSha) {
        markStale(result.diff.headSha);
        return staleAnswer(staleHeadSha);
      }
      const after = await checkHead(signal);
      if (!checkEffective()) return { status: "unavailable", reason: "not-effective" };
      if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
      if (!after.current) return staleAnswer(after.currentHeadSha);
      return result;
    },

    runReadOnlyReviewTurn: async (input, callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective()) {
        return {
          status: "refused",
          reason: "not-effective",
          detail: "The pull request reviewer is no longer active.",
        };
      }
      if (signal.aborted) return { status: "cancelled" };
      if (
        !validBoundedNonEmpty(input.prompt, MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES) ||
        (input.systemInstructions !== undefined &&
          !validBoundedNonEmpty(input.systemInstructions, MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES))
      ) {
        return {
          status: "refused",
          reason: "route-refused",
          detail: "The review turn prompt is empty, contains NUL bytes, or exceeds the size limit.",
        };
      }
      const before = await checkHead(signal);
      if (!checkEffective()) {
        return {
          status: "refused",
          reason: "not-effective",
          detail: "The pull request reviewer is no longer active.",
        };
      }
      if (signal.aborted) return { status: "cancelled" };
      if (!before.current) {
        return {
          status: "refused",
          reason: "head-stale",
          detail: "The pull request head moved before the review turn started.",
        };
      }
      if (delegates.runReadOnlyReviewTurn === undefined) {
        return {
          status: "refused",
          reason: "unsupported",
          detail: "This host does not provide a read-only review turn runner.",
        };
      }
      const result = await delegates.runReadOnlyReviewTurn(input, signal);
      if (!checkEffective()) {
        return {
          status: "refused",
          reason: "not-effective",
          detail: "The pull request reviewer became inactive while the review turn ran.",
        };
      }
      if (signal.aborted) return { status: "cancelled" };
      const after = await checkHead(signal);
      if (!checkEffective()) {
        return {
          status: "refused",
          reason: "not-effective",
          detail: "The pull request reviewer became inactive while the review turn ran.",
        };
      }
      if (signal.aborted) return { status: "cancelled" };
      if (!after.current) {
        return {
          status: "refused",
          reason: "head-stale",
          detail: "The pull request head moved while the review turn ran.",
        };
      }
      if (result.status === "completed") {
        completedTurns.set(String(result.runId), {
          runId: result.runId,
          providerInstanceId: result.providerInstanceId,
          modelId: result.modelId,
          sessionId: result.sessionId,
        });
      }
      return result;
    },

    recordFindings: async (input, callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective()) return { status: "refused", reason: "not-effective" };
      if (signal.aborted) return { status: "refused", reason: "unavailable" };

      let runReceipt: PullRequestReviewTurnReceipt | undefined;
      if (input.runId !== undefined) {
        runReceipt = completedTurns.get(String(input.runId));
        if (runReceipt === undefined) {
          return {
            status: "refused",
            reason: "unknown-run",
            detail: "Findings may only cite a review turn completed within this review.",
          };
        }
      }

      const proposals: Array<PullRequestReviewFindingProposal> = [];
      for (const candidate of input.findings) {
        try {
          proposals.push(decodePullRequestReviewFindingProposal(candidate));
        } catch {
          return { status: "refused", reason: "invalid-findings" };
        }
      }

      if (proposals.length === 0) {
        const before = await checkHead(signal);
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "refused", reason: "unavailable" };
        if (!before.current) return staleAnswer(before.currentHeadSha);
        return { status: "recorded", findings: [] };
      }

      if (
        recordedFindings.size + pendingFindingsCount + proposals.length >
        MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN
      ) {
        return { status: "refused", reason: "limit-exceeded" };
      }

      // Reserve the finding budget synchronously before the first await so
      // concurrent `recordFindings` calls cannot overshoot the per-run cap.
      const reserved = proposals.length;
      pendingFindingsCount += reserved;
      try {
        const before = await checkHead(signal);
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "refused", reason: "unavailable" };
        if (!before.current) return staleAnswer(before.currentHeadSha);

        if (delegates.recordFindings === undefined) {
          return { status: "refused", reason: "unavailable" };
        }

        const result = await delegates.recordFindings(
          runReceipt === undefined ? { proposals } : { proposals, runReceipt },
          signal,
        );
        if (result.status === "stale") {
          markStale(result.currentHeadSha);
          return staleAnswer(staleHeadSha);
        }
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "refused", reason: "unavailable" };
        const after = await checkHead(signal);
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "refused", reason: "unavailable" };
        if (!after.current) return staleAnswer(after.currentHeadSha);
        if (result.status === "recorded") {
          for (const finding of result.findings) {
            recordedFindings.set(String(finding.id), finding);
          }
        }
        return result;
      } finally {
        pendingFindingsCount -= reserved;
      }
    },

    postSummaryComment: async (input, callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective()) return { status: "refused", reason: "not-effective" };
      if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
      if (summaryCommentPosted || summaryCommentInFlight) {
        return { status: "refused", reason: "already-posted" };
      }
      if (delegates.isPostSummaryCommentEnabled?.() !== true) {
        return { status: "disabled" };
      }
      if (!validBoundedNonEmpty(input.body, MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES)) {
        return { status: "refused", reason: "invalid-body" };
      }

      // Reserve the single summary-comment slot synchronously before any await
      // so concurrent calls cannot race into posting twice. Release the
      // in-flight lock in `finally` so a rejected delegate never wedges retries
      // while `summaryCommentPosted` permanently guards after a real post.
      summaryCommentInFlight = true;
      try {
        const before = await checkHead(signal);
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "unavailable", reason: "unavailable" };
        if (!before.current) return staleAnswer(before.currentHeadSha);
        if (delegates.isPostSummaryCommentEnabled?.() !== true) {
          return { status: "disabled" };
        }
        if (delegates.postSummaryComment === undefined) {
          return { status: "unavailable", reason: "unavailable" };
        }

        const result = await delegates.postSummaryComment({ body: input.body }, signal);
        if (result.status === "posted") {
          summaryCommentPosted = true;
          return result;
        }
        if (result.status === "stale") {
          markStale(result.currentHeadSha);
          return staleAnswer(staleHeadSha);
        }
        return result;
      } finally {
        summaryCommentInFlight = false;
      }
    },

    handBackBlockingFindings: async (input, callSignal) => {
      const signal = combineSignals(rootSignal, callSignal);
      if (!checkEffective()) return { status: "refused", reason: "not-effective" };
      if (signal.aborted) return { status: "refused", reason: "turn-refused" };
      if (handedBackToWorker || handBackInFlight) {
        return { status: "refused", reason: "already-handed-back" };
      }
      if (delegates.isSendBlockingFindingsEnabled?.() !== true) {
        return { status: "disabled" };
      }
      if (input.findingIds.length === 0) {
        return { status: "refused", reason: "no-blocking-findings" };
      }
      const uniqueIds = new Set<string>();
      const blocking: Array<CodeReviewFinding> = [];
      for (const findingId of input.findingIds) {
        const key = String(findingId);
        if (uniqueIds.has(key)) continue;
        uniqueIds.add(key);
        const recorded = recordedFindings.get(key);
        if (recorded === undefined) {
          return { status: "refused", reason: "unknown-finding" };
        }
        if (recorded.severity !== "error") {
          return { status: "refused", reason: "no-blocking-findings" };
        }
        blocking.push(recorded);
      }

      // Reserve the single hand-back slot synchronously before any await so
      // concurrent calls cannot wake the worker more than once per review run.
      // Release the in-flight lock in `finally` so a rejected delegate never
      // wedges retries while `handedBackToWorker` guards after a real hand-back.
      handBackInFlight = true;
      try {
        const before = await checkHead(signal);
        if (!checkEffective()) return { status: "refused", reason: "not-effective" };
        if (signal.aborted) return { status: "refused", reason: "turn-refused" };
        if (!before.current) return staleAnswer(before.currentHeadSha);
        if (delegates.isSendBlockingFindingsEnabled?.() !== true) {
          return { status: "disabled" };
        }
        if (delegates.handBackBlockingFindings === undefined) {
          return { status: "disabled" };
        }

        const result = await delegates.handBackBlockingFindings({ findings: blocking }, signal);
        if (result.status === "handed-back") {
          handedBackToWorker = true;
          return result;
        }
        if (result.status === "stale") {
          markStale(result.currentHeadSha);
          return staleAnswer(staleHeadSha);
        }
        return result;
      } finally {
        handBackInFlight = false;
      }
    },
  };

  return {
    port,
    revoke: () => {
      revoked = true;
    },
    observedStale: () =>
      staleHeadSha === undefined
        ? { stale: staleObserved }
        : { stale: staleObserved, currentHeadSha: staleHeadSha },
    observedIneffective: () => ineffectiveObserved,
    recordedFindings: () => [...recordedFindings.values()],
    summaryCommentPosted: () => summaryCommentPosted,
    handedBackToWorker: () => handedBackToWorker,
    completedTurnIds: () => new Set(completedTurns.keys()),
  };
}
