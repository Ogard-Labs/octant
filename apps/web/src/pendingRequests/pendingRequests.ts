import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { WorkRequestClient } from "@octant/client-runtime/work-request-client";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import {
  decodeCodeOperationId,
  decodeProviderSessionId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type OctantMode,
} from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { providerAnswerOutcome } from "../code/codeControllerState";

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

/**
 * `refused` covers every way the host did not take the answer: stale, ended,
 * unreachable. Its message is the one quiet line the row shows.
 */
export type PendingRequestAnswerResult =
  | { readonly status: "answered" }
  | { readonly status: "refused"; readonly message: string };

/** The line a row shows when the host gave no reason of its own. */
export const NOT_DELIVERED: PendingRequestAnswerResult = {
  status: "refused",
  message: "The answer was not delivered. The request may have changed.",
};

/** The line a decision row shows when its turn was not started and the host gave no reason. */
export const NOT_SENT: PendingRequestAnswerResult = {
  status: "refused",
  message: "The reply was not sent. The thread may have moved on.",
};

/**
 * The clients each thread view already answers and sends through; the card
 * adds no route. A decision's answer is the thread's next turn, so Work's turn
 * client is here beside its request client.
 */
export interface PendingRequestAnswerClients {
  readonly chatClient: ChatClient;
  readonly codeClient: CodeClient;
  readonly workRequestClient: WorkRequestClient;
  readonly workTurnClient: Pick<WorkTurnClient, "startFirstTurn">;
}

/** One request's identity across reads: the same waiting question keeps its key. */
export function pendingRequestKey(request: PendingRequest): string {
  return `${request.mode}:${String(request.threadId)}:${answerHandle(request)}`;
}

/** A decision is named by the turn that asked it; every other request by its own id. */
function answerHandle(request: PendingRequest): string {
  if (request.kind === "decision") {
    return request.mode === "code"
      ? `decision:${String(request.answer.operationId)}`
      : `decision:${String(request.answer.turnId)}`;
  }
  const { answer } = request;
  return String("approvalId" in answer ? answer.approvalId : answer.requestId);
}

/** A start screen speaks for some modes: Work's lists Chat and Work, Code's lists Code. */
export function pendingRequestsForModes(
  requests: ReadonlyArray<PendingRequest>,
  modes: ReadonlyArray<OctantMode>,
): ReadonlyArray<PendingRequest> {
  return requests.filter((request) => modes.includes(request.mode));
}

/**
 * The options a row can offer as numbered buttons; an approval has none. A
 * decision offers its recommended option first, so it takes the first number
 * and the first place in focus order, then the rest in the agent's order.
 */
export function pendingRequestChoices(request: PendingRequest): ReadonlyArray<{
  readonly label: string;
  readonly description?: string | undefined;
  readonly recommended?: boolean;
}> {
  if (request.kind === "question") return request.options;
  if (request.kind === "decision") {
    return [
      ...request.options.filter((option) => option.recommended),
      ...request.options.filter((option) => !option.recommended),
    ];
  }
  return [];
}

/**
 * Answer through the mode's existing command with the handle the host listed.
 * A decision's option is sent as the thread's ordinary next turn through the
 * mode's own send command, exactly as the composer would send those words; it
 * asks the host to do nothing else. A refusal is a value, never a throw: the
 * card shows one quiet line and re-reads.
 */
export async function answerPendingRequest(
  clients: PendingRequestAnswerClients,
  request: PendingRequest,
  response: PendingRequestResponse,
): Promise<PendingRequestAnswerResult> {
  try {
    if (request.kind === "decision") {
      if (response.kind !== "choice") return NOT_DELIVERED;
      if (!request.options.some((option) => option.label === response.label)) {
        return NOT_DELIVERED;
      }
      if (request.mode === "code") {
        const started = await clients.codeClient.executeOperation({
          kind: "start-provider-turn",
          operationId: decodeCodeOperationId(globalThis.crypto.randomUUID()),
          threadId: request.answer.threadId,
          checkoutId: request.answer.checkoutId,
          sessionId: decodeProviderSessionId(globalThis.crypto.randomUUID()),
          prompt: await clients.codeClient.putEvidence(request.answer.threadId, response.label),
        });
        if (started.kind === "provider-turn-state" && started.state === "running") {
          return { status: "answered" };
        }
        const refusal =
          started.kind === "operation-failed"
            ? started.failure.message
            : started.kind === "provider-turn-state"
              ? started.failure?.message
              : undefined;
        return refusal === undefined ? NOT_SENT : { status: "refused", message: refusal };
      }
      const started = await clients.workTurnClient.startFirstTurn({
        kind: "start-work-thread-turn",
        requestId: decodeWorkTurnRequestId(globalThis.crypto.randomUUID()),
        threadId: request.answer.threadId,
        turnId: decodeWorkTurnId(globalThis.crypto.randomUUID()),
        prompt: response.label,
        authority: request.answer.authority,
      });
      return started.kind === "accepted" ? { status: "answered" } : NOT_SENT;
    }
    if (request.kind === "approval") {
      if (response.kind === "choice") return NOT_DELIVERED;
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
        return providerAnswerOutcome(result);
      }
      return NOT_DELIVERED;
    }
    if (response.kind !== "choice") return NOT_DELIVERED;
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
      return providerAnswerOutcome(result);
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
    return request.kind === "decision" ? NOT_SENT : NOT_DELIVERED;
  }
}
