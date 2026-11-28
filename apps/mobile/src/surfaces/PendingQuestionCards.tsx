import { useCallback, useEffect } from "react";
import { executeMobileCodeOperation, type MobileRemoteTransport } from "@octant/client-runtime";
import {
  CodeEvidenceReference,
  decodeCodeOperationId,
  decodeHostAnswer,
  type CodeOperationResult,
} from "@octant/contracts";
import {
  PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE,
  PendingRequest,
} from "@octant/contracts/pending-requests";
import {
  forgetSettledQuestionnaireDrafts,
  questionnaireDraftKey,
} from "../approvals/questionnaireDraft";
import { usePolledResource } from "../runtime/usePolledResource";
import { QuestionnaireCard, questionCardAnswerText } from "./QuestionnaireCard";

/** A Chat or Code question the phone can answer in its thread. */
export type ThreadPendingQuestion = Extract<
  PendingRequest,
  { readonly mode: "chat" | "code"; readonly kind: "question" }
>;

const decodePendingRequest = decodeHostAnswer(PendingRequest);

/** The thread's waiting questions, and whether the host's list held all of them. */
export interface ThreadPendingQuestions {
  readonly questions: ReadonlyArray<ThreadPendingQuestion>;
  /**
   * The host cut its list short, so a question missing from it may still be
   * waiting: its unsent answer is kept.
   */
  readonly incomplete: boolean;
}

/**
 * The thread's waiting questions, read from the host's list of what this
 * device can answer, narrowed to this thread before the host's cap so many
 * requests elsewhere never hide them. A host from before that narrowing
 * refuses the query, and its whole list is read instead. Each item is decoded
 * on its own, so a kind a newer host adds never hides the rest. A secret
 * question is left to a surface with a masked field.
 */
export async function listThreadPendingQuestions(
  transport: MobileRemoteTransport,
  mode: "chat" | "code",
  threadId: string,
): Promise<ThreadPendingQuestions> {
  const read = (path: string) =>
    transport.authenticatedFetch({
      method: "GET",
      path,
      headers: { accept: PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE },
    });
  let response = await read(`/api/pending-requests?threadId=${encodeURIComponent(threadId)}`);
  // An older host refuses the query: its route with 400, and its remote
  // listener, which forwards no query on this read, with 404.
  if (response.status === 400 || response.status === 404)
    response = await read("/api/pending-requests");
  if (!response.ok) throw new Error("The host's waiting questions could not be read.");
  const body: unknown = await response.json();
  const items =
    typeof body === "object" && body !== null && "requests" in body && Array.isArray(body.requests)
      ? (body.requests as ReadonlyArray<unknown>)
      : [];
  const incomplete =
    typeof body !== "object" || body === null || !("truncated" in body) || body.truncated !== false;
  const questions: ThreadPendingQuestion[] = [];
  for (const item of items) {
    let request: PendingRequest;
    try {
      request = decodePendingRequest(item);
    } catch {
      continue;
    }
    if (
      request.kind === "question" &&
      (request.mode === "chat" || request.mode === "code") &&
      request.mode === mode &&
      String(request.threadId) === threadId &&
      request.secret !== true
    ) {
      questions.push(request);
    }
  }
  return {
    questions: questions.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)),
    incomplete,
  };
}

function draftScope(transport: MobileRemoteTransport, mode: string, threadId: string): string {
  return questionnaireDraftKey(transport.hostId, mode, threadId);
}

function draftKeyOf(transport: MobileRemoteTransport, request: ThreadPendingQuestion): string {
  const scope = draftScope(transport, request.mode, String(request.threadId));
  return request.mode === "chat"
    ? questionnaireDraftKey(
        scope,
        String(request.answer.turnId),
        String(request.answer.attemptId),
        request.answer.requestId,
      )
    : questionnaireDraftKey(
        scope,
        String(request.answer.checkoutId),
        String(request.answer.requestId),
      );
}

async function refusalOf(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string" &&
      body.message.trim() !== ""
    ) {
      return body.message;
    }
  } catch {
    // The status alone says it was not taken.
  }
  return fallback;
}

/**
 * A refusal can come back as a turn state, not only as a failed operation: a
 * failed or interrupted turn, and a turn still running or waiting that names
 * why it did not take this answer (a harness question already settled, an
 * invalid set). An answer the turn took carries no failure.
 */
function codeRefusal(result: CodeOperationResult): string | undefined {
  if (result.kind === "operation-failed") return result.failure.message;
  if (result.kind !== "provider-turn-state") return undefined;
  if (result.failure !== undefined) return result.failure.message;
  return result.state === "failed"
    ? "The answer was not delivered. The turn changed since it asked."
    : undefined;
}

/**
 * Answers a Chat question through `answer-chat-turn-question`, and a Code
 * question by staging the answer as evidence and sending
 * `answer-provider-input`, the same commands the desktop sends. The host
 * checks the device and the request before the turn goes on.
 */
async function answerThreadQuestion(
  transport: MobileRemoteTransport,
  request: ThreadPendingQuestion,
  text: string,
): Promise<string | undefined> {
  if (request.mode === "chat") {
    const response = await transport.authenticatedFetch({
      method: "POST",
      path: "/api/chat/commands",
      body: JSON.stringify({
        kind: "answer-chat-turn-question",
        threadId: request.answer.threadId,
        expectedVersion: request.answer.expectedVersion,
        turnId: request.answer.turnId,
        attemptId: request.answer.attemptId,
        requestId: request.answer.requestId,
        answer: text,
      }),
    });
    return response.ok ? undefined : refusalOf(response, "The answer was refused.");
  }
  const staged = await transport.authenticatedFetch({
    method: "PUT",
    path: "/api/code/evidence",
    body: text,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-octant-code-thread-id": String(request.answer.threadId),
    },
    contentType: "text/plain; charset=utf-8",
  });
  if (!staged.ok) return refusalOf(staged, "The answer could not be staged on the host.");
  const evidence = decodeHostAnswer(CodeEvidenceReference)(await staged.json());
  const result = await executeMobileCodeOperation(transport, {
    kind: "answer-provider-input",
    operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
    threadId: request.answer.threadId,
    checkoutId: request.answer.checkoutId,
    requestId: request.answer.requestId,
    response: evidence,
  });
  return codeRefusal(result);
}

export interface PendingQuestionCardsProps {
  readonly transport: MobileRemoteTransport;
  readonly mode: "chat" | "code";
  readonly threadId: string;
  readonly watchingOnly?: boolean;
  readonly refreshIntervalMs?: number;
}

/**
 * A Chat or Code thread's waiting question, one or a questionnaire, on the
 * shared question card beside the composer. The turn is held on it, so it is
 * read often while the screen is open.
 */
export function PendingQuestionCards(props: PendingQuestionCardsProps) {
  const load = useCallback(
    () => listThreadPendingQuestions(props.transport, props.mode, props.threadId),
    [props.transport, props.mode, props.threadId],
  );
  const resource = usePolledResource(load, { intervalMs: props.refreshIntervalMs ?? 3_000 });
  const questions = resource.value?.questions ?? [];
  // Only a whole list proves a question is no longer waiting.
  const complete = resource.value?.incomplete === false;
  const waitingKeys = questions.map((request) => draftKeyOf(props.transport, request)).join("\n");
  // A question no longer waiting takes its unsent answers with it.
  useEffect(() => {
    if (!complete) return;
    forgetSettledQuestionnaireDrafts(
      draftScope(props.transport, props.mode, props.threadId),
      waitingKeys === "" ? [] : waitingKeys.split("\n"),
    );
  }, [complete, waitingKeys, props.transport, props.mode, props.threadId]);

  return (
    <>
      {questions.map((request) => {
        const key = draftKeyOf(props.transport, request);
        return (
          <QuestionnaireCard
            ask={
              request.questionnaire === undefined
                ? {
                    kind: "plain",
                    prompt: request.text,
                    options: request.options.map((option) => option.label),
                  }
                : { kind: "questionnaire", questionnaire: request.questionnaire }
            }
            draftKey={key}
            key={key}
            onSend={async (answer) => {
              try {
                return await answerThreadQuestion(
                  props.transport,
                  request,
                  questionCardAnswerText(answer),
                );
              } finally {
                void resource.reload();
              }
            }}
            testID={`mobile-${request.mode}-question`}
            title={request.text}
            watchingOnly={props.watchingOnly === true}
          />
        );
      })}
    </>
  );
}
