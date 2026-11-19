import {
  MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH,
  type FinishedReceiptCheckCommand,
  type FinishedReceiptId,
  type FinishedReceiptItem,
  type FinishedReceiptRecorded,
  type FinishedReceiptStatus,
  type ThreadBoardFinishedMark,
  type ThreadFinishedReceipt,
  type ThreadGoalCriterionId,
} from "@octant/contracts";

/**
 * Host-observed outcome of running one check command for `octant_report_finished`.
 * Expected failures are represented as discriminated values rather than thrown errors.
 */
export type FinishedCheckExecutionOutcome =
  | {
      readonly status: "ran";
      readonly exitCode: number;
      readonly output: string;
    }
  | {
      readonly status: "timed-out";
      readonly output: string;
    }
  | {
      readonly status: "approval-denied";
      readonly reason?: string;
    }
  | {
      readonly status: "approval-cancelled";
      readonly reason?: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface FinishedReceiptItemCounts {
  readonly provenCount: number;
  readonly claimedCount: number;
  readonly failedCount: number;
  readonly unavailableCount: number;
}

export type FinishedReportEvaluation =
  | {
      readonly accepted: true;
      readonly status: FinishedReceiptStatus;
      readonly counts: FinishedReceiptItemCounts;
    }
  | {
      readonly accepted: false;
      readonly failedItems: ReadonlyArray<FinishedReceiptItem>;
      readonly counts: FinishedReceiptItemCounts;
    };

/**
 * Journal-ordered file-change event used to compute receipt staleness.
 * Ordering comes from journal global sequence numbers only.
 */
export interface FinishedReceiptFileChangeSignal {
  readonly sequence: number;
  /**
   * Present for end-of-turn file summaries (e.g. `conversation-turn-changed-files`
   * or `work.turn-updated@1` with `wroteFiles`), which cover edits made earlier in
   * the same turn before `octant_report_finished` ran. Absent for direct file-edit
   * or commit events, which always mark any earlier receipt stale.
   */
  readonly turnId?: string | undefined;
}

export interface SequencedFinishedReceipt {
  readonly sequence: number;
  readonly receipt: FinishedReceiptRecorded;
}

/**
 * Keep at most the last 2,000 characters of check output so failed checks return
 * actionable diagnostics to the agent and recorded receipts stay bounded.
 */
export function boundFinishedCheckOutputTail(output: string): string {
  if (output.length <= MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH) return output;
  return output.slice(-MAX_FINISHED_CHECK_OUTPUT_TAIL_LENGTH);
}

/**
 * Derive one host-observed receipt item from running a named check or a goal
 * criterion's check command. Zero exit code is `proven`; non-zero, timeout, or
 * denied/cancelled approval is `failed`; missing folder/shell is `unavailable`.
 */
export function deriveFinishedReceiptCheckItem(input: {
  readonly kind: "check" | "goal-criterion";
  readonly label: string;
  readonly command: FinishedReceiptCheckCommand;
  readonly criterionId?: ThreadGoalCriterionId | undefined;
  readonly outcome: FinishedCheckExecutionOutcome;
}): FinishedReceiptItem {
  const base = {
    kind: input.kind,
    label: input.label,
    command: input.command,
    ...(input.criterionId === undefined ? {} : { criterionId: input.criterionId }),
  } as const;

  switch (input.outcome.status) {
    case "ran": {
      const tail = boundFinishedCheckOutputTail(input.outcome.output);
      return {
        ...base,
        status: input.outcome.exitCode === 0 ? "proven" : "failed",
        exitCode: input.outcome.exitCode,
        ...(tail.length === 0 ? {} : { outputTail: tail }),
      };
    }
    case "timed-out": {
      const tail = boundFinishedCheckOutputTail(input.outcome.output);
      return {
        ...base,
        status: "failed",
        reason: "Check command timed out.",
        ...(tail.length === 0 ? {} : { outputTail: tail }),
      };
    }
    case "approval-denied":
      return {
        ...base,
        status: "failed",
        reason: input.outcome.reason ?? "Approval was denied.",
      };
    case "approval-cancelled":
      return {
        ...base,
        status: "failed",
        reason: input.outcome.reason ?? "Approval was cancelled.",
      };
    case "unavailable":
      return {
        ...base,
        status: "unavailable",
        reason: input.outcome.reason,
      };
  }
}

/**
 * A goal criterion without a check command cannot be proven by the host.
 * It is always `claimed` until the person confirms it.
 */
export function deriveClaimedGoalCriterionItem(criterion: {
  readonly id: ThreadGoalCriterionId;
  readonly text: string;
}): FinishedReceiptItem {
  return {
    kind: "goal-criterion",
    criterionId: criterion.id,
    label: criterion.text,
    status: "claimed",
  };
}

export function countFinishedReceiptItems(
  items: ReadonlyArray<FinishedReceiptItem>,
): FinishedReceiptItemCounts {
  let provenCount = 0;
  let claimedCount = 0;
  let failedCount = 0;
  let unavailableCount = 0;
  for (const item of items) {
    switch (item.status) {
      case "proven":
        provenCount += 1;
        break;
      case "claimed":
        claimedCount += 1;
        break;
      case "failed":
        failedCount += 1;
        break;
      case "unavailable":
        unavailableCount += 1;
        break;
    }
  }
  return { provenCount, claimedCount, failedCount, unavailableCount };
}

/**
 * Overall receipt status. The agent's own words are never proof: with zero
 * proven checks, a fresh receipt with no failures is `claimed` (or `unavailable`
 * if every item was unavailable), never `proven`.
 */
export function deriveFinishedReceiptStatus(input: {
  readonly items: ReadonlyArray<FinishedReceiptItem>;
  readonly stale: boolean;
}): FinishedReceiptStatus {
  if (input.stale) return "stale";
  const counts = countFinishedReceiptItems(input.items);
  if (counts.failedCount > 0) return "failed";
  if (counts.provenCount > 0) return "proven";
  if (counts.unavailableCount > 0 && counts.claimedCount === 0) return "unavailable";
  return "claimed";
}

/**
 * Evaluate whether a finished report may be recorded. If any check failed,
 * nothing is recorded as finished and the failed items are returned to the
 * agent in the same turn.
 */
export function evaluateFinishedReport(
  items: ReadonlyArray<FinishedReceiptItem>,
): FinishedReportEvaluation {
  const counts = countFinishedReceiptItems(items);
  if (counts.failedCount > 0) {
    return {
      accepted: false,
      failedItems: items.filter((item) => item.status === "failed"),
      counts,
    };
  }
  return {
    accepted: true,
    status: deriveFinishedReceiptStatus({ items, stale: false }),
    counts,
  };
}

/**
 * Decide whether a recorded receipt is stale from journal sequence ordering
 * alone. Any file-change event recorded after the receipt marks it stale,
 * except an end-of-turn summary belonging to the exact turn that reported it.
 */
export function isReceiptStaleAfterJournalEvents(input: {
  readonly receiptSequence: number;
  readonly receiptTurnId?: string | undefined;
  readonly fileChanges: ReadonlyArray<FinishedReceiptFileChangeSignal>;
}): boolean {
  for (const change of input.fileChanges) {
    if (change.sequence <= input.receiptSequence) continue;
    if (
      change.turnId !== undefined &&
      input.receiptTurnId !== undefined &&
      change.turnId === input.receiptTurnId
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Project a thread's recorded finished receipts with status, counts, and
 * journal-ordered staleness.
 */
export function projectThreadFinishedReceipts(input: {
  readonly receipts: ReadonlyArray<SequencedFinishedReceipt>;
  readonly fileChanges: ReadonlyArray<FinishedReceiptFileChangeSignal>;
}): ReadonlyArray<ThreadFinishedReceipt> {
  return input.receipts.map(({ sequence, receipt }) => {
    const stale = isReceiptStaleAfterJournalEvents({
      receiptSequence: sequence,
      receiptTurnId: receipt.turnId,
      fileChanges: input.fileChanges,
    });
    const counts = countFinishedReceiptItems(receipt.items);
    const status = deriveFinishedReceiptStatus({ items: receipt.items, stale });
    return {
      receipt,
      status,
      stale,
      ...counts,
    };
  });
}

/**
 * Derive the compact board card mark from projected thread receipts.
 * Only a fresh (non-stale, non-failed) latest receipt produces a board mark;
 * when a later file change makes the receipt stale, the board mark disappears.
 */
export function finishedBoardMarkFromReceipts(
  receipts: ReadonlyArray<ThreadFinishedReceipt>,
): ThreadBoardFinishedMark | undefined {
  const latest = receipts.at(-1);
  if (latest === undefined || latest.stale || latest.status === "failed") {
    return undefined;
  }
  return {
    receiptId: latest.receipt.receiptId,
    provenCount: latest.provenCount,
    claimedCount: latest.claimedCount,
    recordedAt: latest.receipt.recordedAt,
  };
}

/**
 * Select the finished receipt to attach as completion evidence when a person
 * marks a thread Done. Only a fresh (non-stale) receipt qualifies.
 */
export function selectCompletionReceiptId(
  receiptsOrLatest: ReadonlyArray<ThreadFinishedReceipt> | ThreadFinishedReceipt | undefined,
): FinishedReceiptId | undefined {
  const latest = Array.isArray(receiptsOrLatest) ? receiptsOrLatest.at(-1) : receiptsOrLatest;
  if (latest === undefined || latest.stale || latest.status === "failed") {
    return undefined;
  }
  return latest.receipt.receiptId;
}

/**
 * Build the send-back prefill text on the Review page from any failed or
 * claimed items on the thread's latest receipt. Returns an empty string when
 * there are no failed or claimed items.
 */
export function formatFinishedReceiptSendBackPrefill(
  receipt: ThreadFinishedReceipt | undefined,
): string {
  if (receipt === undefined) return "";
  const needsWork = receipt.receipt.items.filter(
    (item) => item.status === "failed" || item.status === "claimed",
  );
  if (needsWork.length === 0) return "";
  const parts = needsWork.map((item) => {
    const tag = item.status === "failed" ? "failed" : "unverified";
    return `${item.label} (${tag})`;
  });
  return `Please address before finishing: ${parts.join("; ")}`;
}
