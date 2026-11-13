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
import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { PendingRequest, WaitingAsk } from "@octant/contracts/pending-requests";
import { decodeProjectMemoryProposalId } from "@octant/contracts/projects";
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
  | { readonly kind: "choice"; readonly label: string; readonly note?: string };

/** A note rides in the next turn's prompt, so it is bounded like a short message. */
export const MAX_DECISION_NOTE_LENGTH = 2_000;

/** The words a decision answer sends: the label, then the note when there is one. */
function decisionPrompt(response: { readonly label: string; readonly note?: string }): string {
  const note = (response.note ?? "").trim().slice(0, MAX_DECISION_NOTE_LENGTH).trim();
  return note.length === 0 ? response.label : `${response.label}\n\n${note}`;
}

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

/**
 * A subagent waiting on the person. The row finds the request; the answer is
 * given in the parent thread's Agents tab, so there is nothing to answer here.
 */
export type ChildPendingRequest = Extract<
  PendingRequest,
  { readonly kind: "child-approval" | "child-question" }
>;

export function isChildPendingRequest(request: PendingRequest): request is ChildPendingRequest {
  return request.kind === "child-approval" || request.kind === "child-question";
}

/**
 * The agent's own harness approval, waiting on the person. The row finds the
 * request; the approval card in the thread is where it is answered, so there
 * is nothing to answer here.
 */
export type LeadApprovalPendingRequest = Extract<
  PendingRequest,
  { readonly kind: "lead-approval" }
>;

export function isLeadApprovalPendingRequest(
  request: PendingRequest,
): request is LeadApprovalPendingRequest {
  return request.kind === "lead-approval";
}

/**
 * A Work thread's agent waiting on its own question. The row finds the
 * question; the question card in the thread is where it is answered, so there
 * is nothing to answer here.
 */
export type LeadQuestionPendingRequest = Extract<
  PendingRequest,
  { readonly kind: "lead-question" }
>;

export function isLeadQuestionPendingRequest(
  request: PendingRequest,
): request is LeadQuestionPendingRequest {
  return request.kind === "lead-question";
}

/**
 * A row that finds a request and leaves the answer to the thread: a waiting
 * subagent, or the agent's own approval or Work question. None carries an
 * answer handle.
 */
export function isFindOnlyPendingRequest(
  request: PendingRequest,
): request is ChildPendingRequest | LeadApprovalPendingRequest | LeadQuestionPendingRequest {
  return (
    isChildPendingRequest(request) ||
    isLeadApprovalPendingRequest(request) ||
    isLeadQuestionPendingRequest(request)
  );
}

const ROLE_WORD: Readonly<Record<ChildPendingRequest["child"]["role"], string>> = {
  research: "Research",
  implementation: "Implementation",
  review: "Review",
  custom: "Custom",
};

/**
 * What a waiting subagent said, in the product's word for it: "Research
 * subagent needs your approval" or "Review subagent asked a question".
 */
export function childRequestHeadline(request: ChildPendingRequest): string {
  const subject = `${ROLE_WORD[request.child.role]} subagent`;
  return request.kind === "child-approval"
    ? `${subject} needs your approval`
    : `${subject} asked a question`;
}

/** One request's identity across reads: the same waiting question keeps its key. */
export function pendingRequestKey(request: PendingRequest): string {
  return `${request.mode}:${String(request.threadId)}:${answerHandle(request)}`;
}

/**
 * A decision is named by the turn that asked it, a subagent's request by its
 * run and when it asked, the agent's own approval or question by when it
 * asked, and every other request by its own id.
 */
function answerHandle(request: PendingRequest): string {
  if (isChildPendingRequest(request)) {
    return `${request.kind}:${String(request.child.runId)}:${request.requestedAt}:${request.text}`;
  }
  if (isLeadApprovalPendingRequest(request) || isLeadQuestionPendingRequest(request)) {
    return `${request.kind}:${request.requestedAt}:${request.text}`;
  }
  if (request.kind === "decision") {
    return request.mode === "code"
      ? `decision:${String(request.answer.operationId)}`
      : `decision:${String(request.answer.turnId)}`;
  }
  const { answer } = request;
  return String("approvalId" in answer ? answer.approvalId : answer.requestId);
}

/** One ask's identity across reads. */
export function waitingAskKey(ask: WaitingAsk): string {
  return `ask:${ask.kind}:${ask.askId}`;
}

export function waitingAsksForModes(
  asks: ReadonlyArray<WaitingAsk>,
  modes: ReadonlyArray<OctantMode>,
): ReadonlyArray<WaitingAsk> {
  return asks.filter((ask) => modes.includes(ask.mode));
}

/** The two plain answers a list offers for an ask whose row carries all of it. */
export type WaitingAskAnswer = "approve" | "decline";

/**
 * The clients each ask's own card already answers through; a list adds no
 * route. Each is optional: a surface without one offers no answer for that
 * kind and opens the thread instead.
 */
export interface WaitingAskAnswerClients {
  readonly extensionClient?: Pick<ExtensionClient, "decideToolApproval"> | undefined;
  readonly projectClient?: Pick<ProjectClient, "decideMemoryProposal"> | undefined;
}

/** Whether this surface can deliver a plain answer for the ask from where it is listed. */
export function canAnswerWaitingAsk(
  clients: WaitingAskAnswerClients | undefined,
  ask: WaitingAsk,
): boolean {
  if (ask.inPlace !== true || clients === undefined) return false;
  switch (ask.kind) {
    case "tool-approval":
      return clients.extensionClient !== undefined;
    case "memory-proposal":
      return clients.projectClient !== undefined;
    default:
      return false;
  }
}

/**
 * Sends a plain answer through the ask's own decide route, once and never
 * remembered: "always allow" stays on the card in the thread. The host checks
 * who may answer; a refusal comes back as the row's one quiet line.
 */
export async function answerWaitingAsk(
  clients: WaitingAskAnswerClients,
  ask: WaitingAsk,
  answer: WaitingAskAnswer,
): Promise<PendingRequestAnswerResult> {
  if (!canAnswerWaitingAsk(clients, ask)) return NOT_DELIVERED;
  const decision = answer === "approve" ? "approved" : "denied";
  try {
    switch (ask.kind) {
      case "tool-approval": {
        const accepted = await clients.extensionClient?.decideToolApproval({
          approvalId: ask.askId,
          decision,
        });
        return accepted === true ? { status: "answered" } : NOT_DELIVERED;
      }
      case "memory-proposal": {
        const result = await clients.projectClient?.decideMemoryProposal({
          proposalId: decodeProjectMemoryProposalId(ask.askId),
          decision: answer === "approve" ? "confirm" : "decline",
        });
        if (
          result?.kind === "project-memory-proposal-confirmed" ||
          result?.kind === "project-memory-proposal-declined"
        ) {
          return { status: "answered" };
        }
        return result?.kind === "project-memory-proposal-not-applied"
          ? { status: "refused", message: result.message }
          : NOT_DELIVERED;
      }
      default:
        return NOT_DELIVERED;
    }
  } catch {
    return NOT_DELIVERED;
  }
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
  readonly detail?: string | undefined;
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
    if (isFindOnlyPendingRequest(request)) return NOT_DELIVERED;
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
          prompt: await clients.codeClient.putEvidence(
            request.answer.threadId,
            decisionPrompt(response),
          ),
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
        prompt: decisionPrompt(response),
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
