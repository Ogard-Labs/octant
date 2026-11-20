import {
  MAX_REPLAYABLE_RUN_CASES,
  MAX_REPLAYABLE_RUN_CASE_REQUEST_LENGTH,
  type FinishedReceiptRecorded,
  type ReplayableRunCase,
  type ReplayableRunCaseModel,
} from "@octant/contracts";

export interface ReplayableRunCaseThreadRef {
  readonly mode: "work" | "code";
  readonly threadId: string;
}

/**
 * One journal-ordered finished receipt together with the thread and Project
 * facts needed to build a replayable run case.
 */
export interface ReplayableRunCaseCandidate {
  readonly sequence: number;
  readonly receipt: FinishedReceiptRecorded;
  /** Initial user prompt / request of the thread. */
  readonly request?: string | undefined;
  readonly projectName?: string | undefined;
  readonly model?: ReplayableRunCaseModel | undefined;
  /** True when Leave no trace was active on the thread at the receipt's sequence. */
  readonly leavesNoTraceAtRecord?: boolean | undefined;
}

export interface AllProvenShareSummary {
  readonly allProvenCount: number;
  readonly totalCount: number;
  /** Share in `[0, 1]`, or `undefined` when `totalCount === 0`. */
  readonly share: number | undefined;
  /** Human-readable share, e.g. `3/4 (75.0%) all proven`. */
  readonly formatted: string;
}

const MAX_PROJECT_NAME_LENGTH = 256;

function threadKey(ref: ReplayableRunCaseThreadRef): string {
  return `${ref.mode}:${ref.threadId}`;
}

/**
 * Pure, idempotent projection from journal-ordered finished receipts to
 * replayable run cases.
 *
 * Rules:
 * - Threads marked Leave no trace (either when the receipt was recorded or
 *   afterwards) never produce a case, and never consume slots from the cap.
 * - Purged threads are excluded when omitted from the journal or named in
 *   `purgedThreads`.
 * - At most the newest `MAX_REPLAYABLE_RUN_CASES` (200) cases are kept; older
 *   cases are evicted in FIFO order. Returns newest first.
 */
export function projectReplayableRunCases(input: {
  readonly candidates: ReadonlyArray<ReplayableRunCaseCandidate>;
  readonly untracedThreads?: ReadonlyArray<ReplayableRunCaseThreadRef> | undefined;
  readonly purgedThreads?: ReadonlyArray<ReplayableRunCaseThreadRef> | undefined;
  readonly maxCases?: number | undefined;
}): ReadonlyArray<ReplayableRunCase> {
  const limit = Math.max(
    0,
    Math.min(Math.trunc(input.maxCases ?? MAX_REPLAYABLE_RUN_CASES), MAX_REPLAYABLE_RUN_CASES),
  );
  if (limit === 0) return [];

  const excludedThreads = new Set<string>();
  for (const ref of input.untracedThreads ?? []) {
    excludedThreads.add(threadKey(ref));
  }
  for (const ref of input.purgedThreads ?? []) {
    excludedThreads.add(threadKey(ref));
  }

  const ordered = [...input.candidates].sort((left, right) => left.sequence - right.sequence);
  const seenReceiptIds = new Set<string>();
  const eligible: ReplayableRunCase[] = [];

  for (const candidate of ordered) {
    const receiptIdKey = String(candidate.receipt.receiptId);
    if (seenReceiptIds.has(receiptIdKey)) continue;
    seenReceiptIds.add(receiptIdKey);

    if (candidate.leavesNoTraceAtRecord === true) continue;
    if (
      excludedThreads.has(
        threadKey({ mode: candidate.receipt.mode, threadId: candidate.receipt.threadId }),
      )
    ) {
      continue;
    }

    const request = candidate.request?.trim() ?? "";
    if (request.length === 0) continue;
    const boundedRequest =
      request.length <= MAX_REPLAYABLE_RUN_CASE_REQUEST_LENGTH
        ? request
        : request.slice(0, MAX_REPLAYABLE_RUN_CASE_REQUEST_LENGTH);

    const trimmedProjectName = candidate.projectName?.trim() ?? "";
    const project =
      trimmedProjectName.length === 0
        ? { id: candidate.receipt.projectId }
        : {
            id: candidate.receipt.projectId,
            name:
              trimmedProjectName.length <= MAX_PROJECT_NAME_LENGTH
                ? trimmedProjectName
                : trimmedProjectName.slice(0, MAX_PROJECT_NAME_LENGTH),
          };

    const changedFileCount =
      candidate.receipt.diff.status === "observed"
        ? candidate.receipt.diff.changedFiles
        : undefined;

    eligible.push({
      receiptId: candidate.receipt.receiptId,
      threadId: candidate.receipt.threadId,
      mode: candidate.receipt.mode,
      request: boundedRequest,
      project,
      ...(candidate.model === undefined ? {} : { model: candidate.model }),
      receipt: candidate.receipt,
      ...(changedFileCount === undefined ? {} : { changedFileCount }),
      recordedAt: candidate.receipt.recordedAt,
    });
  }

  const capped = eligible.length <= limit ? eligible : eligible.slice(-limit);
  return capped.reverse();
}

/**
 * True only when a receipt exists, is not stale, carries at least one item,
 * and every item has status `proven`. Zero items is never `proven` because
 * the agent's own words are not proof.
 */
export function isFinishedReceiptAllProven(
  receipt: Pick<FinishedReceiptRecorded, "items"> | undefined,
  options?: { readonly stale?: boolean | undefined },
): boolean {
  if (receipt === undefined || options?.stale === true) return false;
  return receipt.items.length > 0 && receipt.items.every((item) => item.status === "proven");
}

/**
 * Computes the share of evaluated run cases whose receipt was all `proven`.
 */
export function summarizeAllProvenShare(
  outcomes: ReadonlyArray<{
    readonly receipt?: Pick<FinishedReceiptRecorded, "items"> | undefined;
    readonly stale?: boolean | undefined;
  }>,
): AllProvenShareSummary {
  const totalCount = outcomes.length;
  let allProvenCount = 0;
  for (const outcome of outcomes) {
    if (isFinishedReceiptAllProven(outcome.receipt, { stale: outcome.stale })) {
      allProvenCount += 1;
    }
  }
  const share = totalCount === 0 ? undefined : allProvenCount / totalCount;
  const percentage = share === undefined ? "n/a" : `${(share * 100).toFixed(1)}%`;
  return {
    allProvenCount,
    totalCount,
    share,
    formatted: `${String(allProvenCount)}/${String(totalCount)} (${percentage}) all proven`,
  };
}
