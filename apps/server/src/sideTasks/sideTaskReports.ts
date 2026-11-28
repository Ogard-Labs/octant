/**
 * What a turn ending in a side-task child means for its offering thread.
 * Pure shaping, kept apart from the wiring so the classification is tested
 * without a host: completions carry the reply, honestly truncated; failures
 * and cancellations carry nothing but how the turn ended.
 */
import {
  MAX_SIDE_TASK_REPORT_TEXT_LENGTH,
  type OctantMode,
  type SideTaskReportOutcome,
  type SideTaskReportOwed,
  type TurnStopReason,
} from "@octant/contracts";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { SideTaskReportEntry, SideTaskReportStore } from "./sideTaskReportStore";

/**
 * What a mode's turn admission needs to take owed reports: the journal's own
 * answer to what the thread is owed, and the mark that the thread is about to
 * read outside content. Admission records the mark itself, once nothing but
 * journaling the turn is left: marking sooner changed a running turn's
 * approvals for a report it never read, and marking later would let the
 * provider read the report unmarked. Answers false when the mark could not be
 * recorded, and the turn is then refused.
 */
export interface SideTaskReportAdmission extends Pick<SideTaskReportStore, "reportsForParent"> {
  readonly recordIngestion: (
    parentThreadId: string,
    reports: ReadonlyArray<Pick<SideTaskReportEntry, "childThreadId" | "report">>,
  ) => boolean;
}

export const SIDE_TASK_REPORT_MARK_REFUSAL =
  "Could not record that a side task's report is outside content. Nothing was sent.";

export type SideTaskReportDraft = Omit<SideTaskReportOwed, "reportId" | "owedAt" | "childThreadId">;

/**
 * Cuts a reply to the report's bound without leaving a dangling half of a
 * surrogate pair or trailing space the stored text schema would refuse.
 */
function boundedReportText(text: string): string {
  let end = Math.min(text.length, MAX_SIDE_TASK_REPORT_TEXT_LENGTH);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** What a stop reason means for the report; nothing for turns that completed. */
export function sideTaskReportOutcomeForStop(
  stopReason: TurnStopReason,
): Exclude<SideTaskReportOutcome, "completed"> | undefined {
  switch (stopReason) {
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      // end-of-turn, max-tokens and waiting are not failures: a completion
      // reports through the completion hook, which carries the reply.
      return undefined;
  }
}

/**
 * The report a completed turn owes, with the reply cut to what one report can
 * honestly carry and the cut admitted. A reply that fits is carried whole.
 */
export function sideTaskCompletionReport(input: {
  readonly parentThreadId: string;
  readonly parentMode: SideTaskReportDraft["parentMode"];
  readonly title: string;
  readonly text: string;
  readonly endedAt: string;
}): SideTaskReportDraft {
  const trimmed = input.text.trim();
  const fits = trimmed.length <= MAX_SIDE_TASK_REPORT_TEXT_LENGTH;
  return {
    parentThreadId: input.parentThreadId,
    parentMode: input.parentMode,
    title: input.title,
    outcome: "completed",
    ...(trimmed.length === 0
      ? {}
      : {
          text: fits ? trimmed : boundedReportText(trimmed),
          ...(fits ? {} : { truncated: true as const }),
        }),
    endedAt: input.endedAt,
  } as SideTaskReportDraft;
}

/** The report a failed or cancelled turn owes: the outcome alone, no text. */
export function sideTaskFailureReport(input: {
  readonly parentThreadId: string;
  readonly parentMode: SideTaskReportDraft["parentMode"];
  readonly title: string;
  readonly outcome: Exclude<SideTaskReportOutcome, "completed">;
  readonly endedAt: string;
}): SideTaskReportDraft {
  return {
    parentThreadId: input.parentThreadId,
    parentMode: input.parentMode,
    title: input.title,
    outcome: input.outcome,
    endedAt: input.endedAt,
  } as SideTaskReportDraft;
}

/**
 * The turn-end hooks that owe reports, kept together so the completion a
 * turn's reply already reported is never reported again when the turn ends.
 * `parentOf` answers only for a thread a side task started; `offerFor` names
 * the offer the child came from, whose title and mode the report carries.
 */
export function createSideTaskReportDetection(deps: {
  readonly parentOf: (childThreadId: string) => string | undefined;
  readonly offerFor: (
    childThreadId: string,
    parentThreadId: string,
  ) => { readonly title: string; readonly mode: OctantMode } | undefined;
  readonly reports: Pick<SideTaskReportStore, "owe">;
  readonly now: () => string;
}): {
  turnStarted(threadId: string): void;
  turnCompleted(input: { readonly threadId: string; readonly text: string }): void;
  turnEnded(
    threadId: string,
    turn: { readonly stopReason: TurnStopReason; readonly endedAt: string },
  ): void;
} {
  // A completed turn's report is owed at completion; remembering it here keeps
  // the end hook from owing the same turn's outcome a second time.
  const completionsPending = new Set<string>();
  return {
    turnStarted(threadId) {
      completionsPending.delete(threadId);
    },
    turnCompleted(input) {
      const parentThreadId = deps.parentOf(input.threadId);
      if (parentThreadId === undefined) return;
      completionsPending.add(input.threadId);
      const offer = deps.offerFor(input.threadId, parentThreadId);
      if (offer === undefined) return;
      deps.reports.owe(
        input.threadId,
        sideTaskCompletionReport({
          parentThreadId,
          parentMode: offer.mode,
          title: offer.title,
          text: input.text,
          endedAt: deps.now(),
        }),
      );
    },
    turnEnded(threadId, turn) {
      if (completionsPending.delete(threadId)) return;
      const outcome = sideTaskReportOutcomeForStop(turn.stopReason);
      const parentThreadId = outcome === undefined ? undefined : deps.parentOf(threadId);
      const offer =
        parentThreadId === undefined ? undefined : deps.offerFor(threadId, parentThreadId);
      if (outcome === undefined || parentThreadId === undefined || offer === undefined) return;
      deps.reports.owe(
        threadId,
        sideTaskFailureReport({
          parentThreadId,
          parentMode: offer.mode,
          title: offer.title,
          outcome,
          endedAt: turn.endedAt,
        }),
      );
    },
  };
}

/**
 * Marks the parent before a child's report enters it. The child's words may
 * relay what it fetched, so the parent reads them tainted exactly as it would
 * a subagent's result. One reference per child and report keeps a retried
 * batch from double-counting a report already recorded.
 */
export function recordSideTaskReportIngestion(
  record: (input: RecordExternalContentIngestionInput) => ExternalContentIngestionResult,
  parentThreadId: string,
  reports: ReadonlyArray<{ readonly childThreadId: string; readonly report: SideTaskReportOwed }>,
  uuid: () => string,
): boolean {
  try {
    for (const entry of reports) {
      const result = record({
        threadId: parentThreadId,
        provenance: { origin: "tool-result", sourceLabel: "side-task-report" },
        contentReference: `side-task-report-${entry.childThreadId}-${String(entry.report.reportId)}`,
        correlationId: uuid(),
        authorized: true,
      });
      if (result.kind === "refused") return false;
    }
    return true;
  } catch {
    return false;
  }
}
