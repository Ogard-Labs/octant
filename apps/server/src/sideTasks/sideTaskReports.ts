/**
 * What a turn ending in a side-task child means for its offering thread.
 * Pure shaping, kept apart from the wiring so the classification is tested
 * without a host: completions carry the reply, honestly truncated; failures
 * and cancellations carry nothing but how the turn ended.
 */
import {
  MAX_SIDE_TASK_REPORT_TEXT_LENGTH,
  type SideTaskReportOutcome,
  type SideTaskReportOwed,
  type TurnStopReason,
} from "@octant/contracts";

export type SideTaskReportDraft = Omit<SideTaskReportOwed, "reportId" | "owedAt">;

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
          text: fits ? trimmed : trimmed.slice(0, MAX_SIDE_TASK_REPORT_TEXT_LENGTH),
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
