import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import { decodeCodeOperationId, type OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";

/** Rows the Needs you card lists before it says "+N more". */
export const NEEDS_YOU_ROW_LIMIT = 5;

/**
 * What a person chose on a row. The row names the choice; the mode's own
 * command shape stays in {@link answerPendingRequest}, so a row never learns
 * which provider is waiting.
 */
export type PendingRequestResponse =
  | { readonly kind: "approve" }
  | { readonly kind: "deny" }
  | { readonly kind: "choice"; readonly label: string };

/** `refused` covers every way the host did not take the answer: stale, ended, unreachable. */
export type PendingRequestAnswerResult =
  | { readonly status: "answered" }
  | { readonly status: "refused" };

/** The clients each thread view already answers through; the card adds no route. */
export interface PendingRequestAnswerClients {
  readonly chatClient: ChatClient;
  readonly codeClient: CodeClient;
  readonly workRequestClient: WorkRequestClient;
}

/** One request's identity across reads: the same waiting question keeps its key. */
export function pendingRequestKey(request: PendingRequest): string {
  const { answer } = request;
  const handle = "approvalId" in answer ? answer.approvalId : answer.requestId;
  return `${request.mode}:${String(request.threadId)}:${String(handle)}`;
}

/** A start screen speaks for some modes: Work's lists Chat and Work, Code's lists Code. */
export function pendingRequestsForModes(
  requests: ReadonlyArray<PendingRequest>,
  modes: ReadonlyArray<OctantMode>,
): ReadonlyArray<PendingRequest> {
  return requests.filter((request) => modes.includes(request.mode));
}

/** The options a row can offer as numbered buttons; an approval has none. */
export function pendingRequestChoices(
  request: PendingRequest,
): ReadonlyArray<{ readonly label: string; readonly description?: string | undefined }> {
  return request.kind === "question" ? request.options : [];
}

/**
 * Answer through the mode's existing command with the handle the host listed.
 * A refusal is a value, never a throw: the card shows one quiet line and
 * re-reads.
 */
export async function answerPendingRequest(
  clients: PendingRequestAnswerClients,
  request: PendingRequest,
  response: PendingRequestResponse,
): Promise<PendingRequestAnswerResult> {
  try {
    if (request.kind === "approval") {
      if (response.kind === "choice") return { status: "refused" };
      const approved = response.kind === "approve";
      if (request.mode === "work") {
        await clients.workRequestClient.execute({
          kind: "resolve-work-request",
          requestId: request.answer.requestId,
          expectedVersion: request.answer.expectedVersion,
          resolution: { kind: "approval", approved },
        });
        return { status: "answered" };
      }
      if (request.mode === "code") {
        const result = await clients.codeClient.executeOperation({
          kind: "answer-provider-approval",
          operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
          threadId: request.answer.threadId,
          checkoutId: request.answer.checkoutId,
          approvalId: request.answer.approvalId,
          decision: approved ? "approved" : "denied",
        });
        return result.kind === "operation-failed" ? { status: "refused" } : { status: "answered" };
      }
      return { status: "refused" };
    }
    if (response.kind !== "choice") return { status: "refused" };
    if (request.mode === "work") {
      await clients.workRequestClient.execute({
        kind: "resolve-work-request",
        requestId: request.answer.requestId,
        expectedVersion: request.answer.expectedVersion,
        resolution: { kind: "user-input", answer: response.label },
      });
      return { status: "answered" };
    }
    if (request.mode === "code") {
      const result = await clients.codeClient.executeOperation({
        kind: "answer-provider-input",
        operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
        threadId: request.answer.threadId,
        checkoutId: request.answer.checkoutId,
        requestId: request.answer.requestId,
        response: await clients.codeClient.putEvidence(request.answer.threadId, response.label),
      });
      return result.kind === "operation-failed" ? { status: "refused" } : { status: "answered" };
    }
    await clients.chatClient.execute({
      kind: "answer-chat-turn-question",
      threadId: request.answer.threadId,
      expectedVersion: request.answer.expectedVersion,
      turnId: request.answer.turnId,
      attemptId: request.answer.attemptId,
      requestId: request.answer.requestId,
      answer: response.label,
    });
    return { status: "answered" };
  } catch {
    return { status: "refused" };
  }
}
