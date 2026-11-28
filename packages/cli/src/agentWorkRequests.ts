import {
  decodeHostAnswer,
  decodeWorkQuestionnaireResponse,
  decodeWorkRequestList,
  MAX_SECRET_ANSWER_LENGTH,
  type Questionnaire,
  type QuestionnaireQuestion,
  type QuestionnaireResponse,
  type WorkAccess,
  type WorkLevelChangeRequest,
} from "@octant/contracts";
import { PendingRequest } from "@octant/contracts/pending-requests";
import { questionAnswerIsAllowed, validateQuestionnaireAnswer } from "@octant/domain";
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
  // The row carries a questionnaire itself; the request route's journaled
  // one is still read, so a host whose rows predate it is answered the same.
  | Extract<PendingWorkRequest, { kind: "question" }>;
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

/**
 * Said instead of taking a typed answer to a question that asks for a secret.
 * The composer echoes what is typed, so a secret goes only through the masked
 * entry (`answerWorkSecret`); where that cannot run, the app's field answers.
 */
export const WORK_SECRET_QUESTION_REFUSAL =
  "This question asks for a secret. Answer it in the masked field, or in the app.";

export async function answerWorkRequest(
  session: OpenedLocalControlSession,
  request: AgentWorkRequest,
  text: string,
): Promise<string | undefined> {
  if (request.kind === "question" && request.secret === true) return WORK_SECRET_QUESTION_REFUSAL;
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
 * Which host takes the answer: Work refuses paths and links in what is
 * written, while Chat checks the whole response against the questionnaire.
 */
export type QuestionnaireHost = "work" | "chat";

/**
 * One answer typed at the terminal for the questionnaire's next unanswered
 * question: option numbers (comma or space separated), an option's label,
 * `0` for no choice where the question allows none, or a written alternative
 * where it allows one. A refused line keeps the earlier answers and asks the
 * same question again. After the last question comes the optional comment,
 * unless the ask refuses one; then the response is complete and the host
 * validates it whole.
 */
export function stepWorkQuestionnaire(
  questionnaire: Questionnaire,
  answers: ReadonlyArray<AgentQuestionnaireAnswer>,
  text: string,
  host: QuestionnaireHost = "work",
): QuestionnaireStep {
  const question = questionnaire.questions[answers.length];
  if (question === undefined) return completeWithComment(questionnaire, answers, text.trim(), host);
  const answer = readQuestionAnswer(question, text.trim(), host);
  if (typeof answer === "string") return { kind: "asking", answers, note: answer };
  const next = [...answers, answer];
  if (next.length < questionnaire.questions.length) return { kind: "asking", answers: next };
  // The app's form offers a comment unless the ask refuses one, so the
  // terminal asks for it last; an empty line sends the answers without one.
  return questionnaire.allowComment === false
    ? { kind: "complete", response: { version: 1, answers: next } }
    : { kind: "asking", answers: next };
}

/** Whether every question is answered and only the optional comment is still asked. */
export function workQuestionnaireAwaitsComment(
  questionnaire: Questionnaire,
  answers: ReadonlyArray<AgentQuestionnaireAnswer>,
): boolean {
  return questionnaire.allowComment !== false && answers.length === questionnaire.questions.length;
}

function completeWithComment(
  questionnaire: Questionnaire,
  answers: ReadonlyArray<AgentQuestionnaireAnswer>,
  comment: string,
  host: QuestionnaireHost,
): QuestionnaireStep {
  const response = {
    version: 1 as const,
    answers: [...answers],
    ...(comment.length === 0 ? {} : { comment }),
  };
  if (host === "chat")
    return validateQuestionnaireAnswer(questionnaire, JSON.stringify(response)).status === "valid"
      ? { kind: "complete", response }
      : {
          kind: "asking",
          answers,
          note: "Chat cannot deliver that comment. Keep it under 2,000 characters, or press Enter to send without one.",
        };
  try {
    decodeWorkQuestionnaireResponse(response);
  } catch {
    return {
      kind: "asking",
      answers,
      note: "Work cannot deliver that comment. Keep it under 2,000 characters, without paths or links.",
    };
  }
  return { kind: "complete", response };
}

function readQuestionAnswer(
  question: QuestionnaireQuestion,
  text: string,
  host: QuestionnaireHost,
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
  // Exactly one "=" is consumed, and only before a number: "==12" sends "=12",
  // and "=SUM(B2:B5)" is sent as written.
  const choice = /^\d+([\s,]+\d+)*$/;
  const escaped = text.startsWith("=") ? text.slice(1).trim() : undefined;
  // The "=" run must be contiguous: "= =12" is written text, sent as typed.
  const written =
    writes && escaped !== undefined && choice.test(text.replace(/^=+/, "").trim())
      ? escaped
      : undefined;
  if (written === undefined && choice.test(text)) {
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
  // An option's own label chooses it, as picking it in line mode or naming it
  // from an outside agent sends the label rather than its number.
  const named =
    written === undefined
      ? question.options.find((option) => option.label.toLowerCase() === text.toLowerCase())
      : undefined;
  if (named !== undefined) {
    const answer = { questionId: question.id, selectedOptionIds: [named.id] };
    return questionAnswerIsAllowed(question, answer) ? answer : refusal;
  }
  if (!writes) return refusal;
  const answer = {
    questionId: question.id,
    selectedOptionIds: [],
    customAnswer: written ?? text,
  };
  if (host === "chat")
    return answer.customAnswer.length > 0 && answer.customAnswer.length <= 2_000
      ? answer
      : "Write an answer of at most 2,000 characters.";
  try {
    // Work answers carry no path or link; refuse here rather than after the last question.
    decodeWorkQuestionnaireResponse({ version: 1, answers: [answer] });
  } catch {
    return "Work cannot deliver that answer. Leave out paths and links.";
  }
  return answer;
}

/**
 * Answers a secret question the way the app's masked field does: the value
 * travels only as the command's `secretAnswer`, beside a resolution that
 * records that a secret was given. The caller drops its copy once this
 * resolves; nothing here keeps, logs or prints it.
 */
export async function answerWorkSecret(
  session: OpenedLocalControlSession,
  request: AgentWorkRequest,
  secret: string,
): Promise<string | undefined> {
  if (request.kind !== "question" || request.secret !== true)
    return "That question does not ask for a secret.";
  if (secret.trim().length === 0 || secret.length > MAX_SECRET_ANSWER_LENGTH)
    return `A secret answer is between 1 and ${String(MAX_SECRET_ANSWER_LENGTH)} characters.`;
  return resolveWorkRequest(session, request, { kind: "user-input", secret: true }, secret);
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
    | { readonly kind: "user-input"; readonly answer: string | QuestionnaireResponse }
    | { readonly kind: "user-input"; readonly secret: true },
  secretAnswer?: string,
): Promise<string | undefined> {
  const response = await session.send({
    path: "/api/work/requests/commands",
    method: "POST",
    body: {
      kind: "resolve-work-request",
      ...request.answer,
      resolution,
      ...(secretAnswer === undefined ? {} : { secretAnswer }),
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
  if (question === undefined)
    return workQuestionnaireAwaitsComment(questionnaire, answers)
      ? "Add a comment for the agent, or press Enter to send your answers."
      : "";
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
      ? ", or your own answer (start it with = if it is a number; == keeps a leading =)"
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
/**
 * What a Work approval that changes the thread's level authorizes, as the
 * app's approval card shows it: the whole plan the agent hands over, then the level
 * the thread moves to. The level comes last, beside the y/n line, because the
 * panel sits at the bottom of the scrolled transcript: a tall task list or a
 * wrapped plan pushes the top of the panel up, never its last lines. Empty for
 * an approval that changes no level.
 */
export function workLevelChangeText(levelChange: WorkLevelChangeRequest | undefined): string {
  if (levelChange === undefined) return "";
  const lines: string[] = [];
  if (levelChange.plan !== undefined) lines.push("Plan:", levelChange.plan);
  lines.push(`Allowing moves this thread to ${WORK_ACCESS_LABEL[levelChange.to]}.`);
  return lines.join("\n");
}
