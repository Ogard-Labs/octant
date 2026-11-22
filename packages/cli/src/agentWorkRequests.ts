import {
  decodeHostAnswer,
  decodeWorkQuestionnaireResponse,
  decodeWorkRequestList,
  type Questionnaire,
  type QuestionnaireQuestion,
  type QuestionnaireResponse,
  type WorkAccess,
  type WorkLevelChangeRequest,
} from "@octant/contracts";
import { PendingRequest } from "@octant/contracts/pending-requests";
import { questionAnswerIsAllowed } from "@octant/domain";
import type { OpenedLocalControlSession } from "./localControl";
import { refusalMessage } from "./agentHost";

type PendingWorkRequest = Extract<PendingRequest, { mode: "work"; kind: "approval" | "question" }>;
/**
 * A pending Work request as the terminal answers it. The pending-request list
 * flattens a questionnaire to its prompt and an approval to its description,
 * so the journaled questionnaire and the level an approval would move the
 * thread to (with the plan it hands over) are read from the Work request route
 * the app's thread view uses.
 */
export type AgentWorkRequest =
  | (Extract<PendingWorkRequest, { kind: "approval" }> & {
      readonly levelChange?: WorkLevelChangeRequest;
    })
  | (Extract<PendingWorkRequest, { kind: "question" }> & {
      readonly questionnaire?: Questionnaire;
    });
export type AgentQuestionnaireAnswer = QuestionnaireResponse["answers"][number];
export type AgentWorkRequestRead =
  | { readonly kind: "ready"; readonly requests: ReadonlyArray<AgentWorkRequest> }
  | { readonly kind: "refused"; readonly message: string };

export function workRequestId(request: AgentWorkRequest): string {
  return String(request.answer.requestId);
}

export async function readWorkRequests(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<AgentWorkRequestRead> {
  try {
    const response = await session.send({ path: "/api/pending-requests", method: "GET" });
    if (response.status !== 200)
      return {
        kind: "refused",
        message: refusalMessage(response, "Provider requests are unavailable."),
      };
    const rows =
      typeof response.body === "object" && response.body !== null && "requests" in response.body
        ? response.body.requests
        : undefined;
    if (!Array.isArray(rows))
      return { kind: "refused", message: "Provider requests are unavailable." };
    const pending = rows.flatMap((row: unknown) => {
      const request = decodeHostAnswer(PendingRequest)(row);
      return request.mode === "work" &&
        String(request.threadId) === threadId &&
        (request.kind === "approval" || request.kind === "question")
        ? [request]
        : [];
    });
    const first = pending[0];
    if (first === undefined) return { kind: "ready", requests: [] };
    // A request whose definition cannot be read is not offered at all: a
    // questionnaire answered as plain text is refused by the host, and an
    // approval that changes the thread's level must show that level and plan.
    const details = await session.send({
      path: `/api/work/requests?projectId=${encodeURIComponent(String(first.projectId))}&threadId=${encodeURIComponent(threadId)}`,
      method: "GET",
    });
    if (details.status !== 200)
      return {
        kind: "refused",
        message: refusalMessage(details, "Provider requests are unavailable."),
      };
    const detailById = new Map(
      decodeWorkRequestList(details.body).requests.map(
        (request) => [String(request.requestId), request.detail] as const,
      ),
    );
    const requests = pending.flatMap((request): ReadonlyArray<AgentWorkRequest> => {
      const detail = detailById.get(workRequestId(request));
      if (detail === undefined) return [];
      if (request.kind === "approval")
        return detail.kind === "approval" && detail.levelChange !== undefined
          ? [{ ...request, levelChange: detail.levelChange }]
          : [request];
      return detail.kind === "user-input" && detail.questionnaire !== undefined
        ? [{ ...request, questionnaire: detail.questionnaire }]
        : [request];
    });
    return { kind: "ready", requests };
  } catch {
    return { kind: "refused", message: "Provider requests are unavailable." };
  }
}

export async function answerWorkRequest(
  session: OpenedLocalControlSession,
  request: AgentWorkRequest,
  text: string,
): Promise<string | undefined> {
  if (request.kind === "approval") {
    if (!/^(y|yes|n|no)$/i.test(text)) return "Answer the approval with y or n.";
    return resolveWorkRequest(session, request, {
      kind: "approval",
      approved: /^(y|yes)$/i.test(text),
    });
  }
  const selected = /^\d+$/.test(text) ? request.options[Number(text) - 1]?.label : undefined;
  return resolveWorkRequest(session, request, { kind: "user-input", answer: selected ?? text });
}

export type QuestionnaireStep =
  | {
      readonly kind: "asking";
      readonly answers: ReadonlyArray<AgentQuestionnaireAnswer>;
      readonly note?: string;
    }
  | { readonly kind: "complete"; readonly response: QuestionnaireResponse };

/**
 * One answer typed at the terminal for the questionnaire's next unanswered
 * question: option numbers (comma or space separated), `0` for no choice
 * where the question allows none, or a written alternative where it allows
 * one. A refused line keeps the earlier answers and asks the same question
 * again. The last answer completes the response the host validates whole.
 */
export function stepWorkQuestionnaire(
  questionnaire: Questionnaire,
  answers: ReadonlyArray<AgentQuestionnaireAnswer>,
  text: string,
): QuestionnaireStep {
  const question = questionnaire.questions[answers.length];
  if (question === undefined)
    return { kind: "complete", response: { version: 1, answers: [...answers] } };
  const answer = readQuestionAnswer(question, text.trim());
  if (typeof answer === "string") return { kind: "asking", answers, note: answer };
  const next = [...answers, answer];
  return next.length === questionnaire.questions.length
    ? { kind: "complete", response: { version: 1, answers: next } }
    : { kind: "asking", answers: next };
}

function readQuestionAnswer(
  question: QuestionnaireQuestion,
  text: string,
): AgentQuestionnaireAnswer | string {
  const min = question.minSelections ?? 1;
  const max =
    question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length);
  const limits =
    question.selection === "single"
      ? "Choose one option by number"
      : `Choose ${min === max ? String(min) : `${String(min)} to ${String(max)}`} options by number`;
  const writes = question.allowCustom !== false;
  const refusal = `${limits}${writes ? ", or type your own answer" : ""}.`;
  // Bare numbers choose options, so a written answer that is itself a number
  // starts with "=" (seen in review: "12 copies" typed as 12 was refused).
  const written = writes && text.startsWith("=") ? text.slice(1).trim() : undefined;
  if (written === undefined && /^\d+([\s,]+\d+)*$/.test(text)) {
    const numbers = text.split(/[\s,]+/).map(Number);
    const selectedOptionIds =
      numbers.length === 1 && numbers[0] === 0
        ? []
        : numbers.map((number) => question.options[number - 1]?.id);
    const answer = {
      questionId: question.id,
      selectedOptionIds: selectedOptionIds.filter((id) => id !== undefined),
    };
    return selectedOptionIds.every((id) => id !== undefined) &&
      questionAnswerIsAllowed(question, answer)
      ? answer
      : refusal;
  }
  if (!writes) return refusal;
  if (written !== undefined && written.length === 0) return refusal;
  const answer = {
    questionId: question.id,
    selectedOptionIds: [],
    customAnswer: written ?? text,
  };
  try {
    // Work answers carry no path or link; refuse here rather than after the last question.
    decodeWorkQuestionnaireResponse({ version: 1, answers: [answer] });
  } catch {
    return "Work cannot deliver that answer. Leave out paths and links.";
  }
  return answer;
}

export async function answerWorkQuestionnaire(
  session: OpenedLocalControlSession,
  request: AgentWorkRequest,
  response: QuestionnaireResponse,
): Promise<string | undefined> {
  return resolveWorkRequest(session, request, { kind: "user-input", answer: response });
}

async function resolveWorkRequest(
  session: OpenedLocalControlSession,
  request: AgentWorkRequest,
  resolution:
    | { readonly kind: "approval"; readonly approved: boolean }
    | { readonly kind: "user-input"; readonly answer: string | QuestionnaireResponse },
): Promise<string | undefined> {
  const response = await session.send({
    path: "/api/work/requests/commands",
    method: "POST",
    body: {
      kind: "resolve-work-request",
      ...request.answer,
      resolution,
    },
  });
  const body =
    typeof response.body === "object" && response.body !== null ? response.body : undefined;
  const kind =
    body !== undefined && "kind" in body && typeof body.kind === "string" ? body.kind : undefined;
  const failureMessage =
    body !== undefined &&
    "failure" in body &&
    typeof body.failure === "object" &&
    body.failure !== null &&
    "message" in body.failure &&
    typeof body.failure.message === "string"
      ? body.failure.message
      : undefined;
  if (response.status !== 200 || kind !== "work-request-resolved")
    return refusalMessage(response, failureMessage ?? "The answer was refused.");
  return undefined;
}

/** The questionnaire's next question as the terminal's request panel shows it. */
export function workQuestionnaireText(
  questionnaire: Questionnaire,
  answers: ReadonlyArray<AgentQuestionnaireAnswer>,
): string {
  const question = questionnaire.questions[answers.length];
  if (question === undefined) return "";
  const min = question.minSelections ?? 1;
  const options = question.options.map(
    (option, index) =>
      `${String(index + 1)}. ${option.label}` +
      (option.recommended === true ? " (recommended)" : "") +
      (option.description === undefined ? "" : ` — ${option.description}`),
  );
  const hint =
    (question.selection === "single" ? "Type a number" : "Type numbers separated by commas") +
    (min === 0 ? ", 0 for none" : "") +
    (question.allowCustom !== false
      ? ", or your own answer (start it with = if it is a number)"
      : "") +
    ", then Enter.";
  return [
    `Question ${String(answers.length + 1)} of ${String(questionnaire.questions.length)}: ${question.prompt}`,
    ...options,
    hint,
  ].join("\n");
}

const WORK_ACCESS_LABEL: Readonly<Record<WorkAccess, string>> = {
  "ask-first": "Ask first",
  "auto-accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
  plan: "Plan",
};
/** A plan longer than this many lines is cut in the panel, and the panel says so. */
const PLAN_PANEL_LINES = 20;

/**
 * What a Work approval that changes the thread's level authorizes, as the
 * app's approval card shows it: the level the thread moves to and the plan the
 * agent hands over. Empty for an approval that changes no level.
 */
export function workLevelChangeText(levelChange: WorkLevelChangeRequest | undefined): string {
  if (levelChange === undefined) return "";
  const lines = [`Allowing moves this thread to ${WORK_ACCESS_LABEL[levelChange.to]}.`];
  if (levelChange.plan !== undefined) {
    const plan = levelChange.plan.split("\n");
    lines.push("Plan:", ...plan.slice(0, PLAN_PANEL_LINES));
    if (plan.length > PLAN_PANEL_LINES)
      lines.push(
        `… ${String(plan.length - PLAN_PANEL_LINES)} more lines. Read the whole plan in the app before allowing.`,
      );
  }
  return lines.join("\n");
}
