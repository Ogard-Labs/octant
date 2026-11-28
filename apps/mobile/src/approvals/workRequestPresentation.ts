import type { Questionnaire, WorkRequest } from "@octant/contracts";
import { levelChangePresentation, type LevelChangePresentation } from "./levelChangePresentation";

/**
 * Which card a pending Work request draws on the phone, with the desktop's
 * words: the Plan block for a level change, the provider approval for a tool
 * call, and the provider question as one question or a questionnaire.
 */
export type WorkRequestCard =
  | { readonly kind: "level-change"; readonly shown: LevelChangePresentation }
  | { readonly kind: "tool-approval"; readonly label: string; readonly summary: string }
  | {
      readonly kind: "question";
      readonly prompt: string;
      readonly options: ReadonlyArray<string>;
    }
  | {
      readonly kind: "questionnaire";
      readonly prompt: string;
      readonly questionnaire: Questionnaire;
    };

export function workRequestCard(request: WorkRequest): WorkRequestCard | undefined {
  if (request.status !== "pending") return undefined;
  const detail = request.detail;
  if (detail.kind === "approval") {
    const shown = levelChangePresentation(request);
    if (shown !== undefined) return { kind: "level-change", shown };
    return {
      kind: "tool-approval",
      label: "Provider approval",
      summary: `${detail.action}: ${detail.description}`,
    };
  }
  return detail.questionnaire === undefined
    ? { kind: "question", prompt: detail.prompt, options: detail.options }
    : { kind: "questionnaire", prompt: detail.prompt, questionnaire: detail.questionnaire };
}

/** The oldest ask first, as the turn met them. */
export function pendingWorkRequestsInOrder(
  requests: ReadonlyArray<WorkRequest>,
): ReadonlyArray<WorkRequest> {
  return requests
    .filter((request) => request.status === "pending")
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}
