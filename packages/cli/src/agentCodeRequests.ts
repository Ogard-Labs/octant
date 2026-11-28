import { randomUUID } from "node:crypto";
import { CodeEvidenceReference, decodeHostAnswer } from "@octant/contracts";
import {
  PENDING_REQUEST_APPROVAL_SUBJECTS_MEDIA_TYPE,
  PendingRequest,
} from "@octant/contracts/pending-requests";
import type { OpenedLocalControlSession } from "./localControl";
import { refusalMessage } from "./agentHost";

export type AgentCodeRequest = Extract<
  PendingRequest,
  { mode: "code"; kind: "approval" | "question" }
>;
export type AgentCodeRequestRead =
  | { readonly kind: "ready"; readonly requests: readonly AgentCodeRequest[] }
  | { readonly kind: "refused"; readonly message: string };

export function codeRequestId(request: AgentCodeRequest): string {
  return request.kind === "approval"
    ? String(request.answer.approvalId)
    : String(request.answer.requestId);
}

/**
 * Why the terminal sends the person to the thread instead of taking y or n,
 * or undefined for an approval of one tool call. Entering or leaving Plan
 * changes the level the thread's later turns run at, and leaving it accepts a
 * plan the pending list does not carry, so a y here would allow what the
 * person never saw. An approval from a host that names neither subject is
 * treated the same way, as the app's lists treat it.
 */
export function codeApprovalOpensThread(request: AgentCodeRequest): string | undefined {
  if (request.kind !== "approval" || request.approves === "tool-call") return undefined;
  return request.approves === "level-change"
    ? "This asks to move the thread into or out of Plan. Open this thread in the Octant app to read the plan and the level it moves to, and answer there."
    : "Open this thread in the Octant app to answer: this host does not say whether the approval changes the thread's level.";
}
export async function readCodeRequests(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<AgentCodeRequestRead> {
  try {
    // Asks for `approves`, so a level change is told apart from a tool call.
    const response = await session.send({
      path: "/api/pending-requests",
      method: "GET",
      headers: { accept: PENDING_REQUEST_APPROVAL_SUBJECTS_MEDIA_TYPE },
    });
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
    const requests = rows.flatMap((row: unknown) => {
      const request = decodeHostAnswer(PendingRequest)(row);
      return request.mode === "code" &&
        String(request.threadId) === threadId &&
        (request.kind === "question" ||
          (request.kind === "approval" && request.browserOrigin === undefined))
        ? [request]
        : [];
    });
    return { kind: "ready", requests };
  } catch {
    return { kind: "refused", message: "Provider requests are unavailable." };
  }
}
export async function answerCodeRequest(
  session: OpenedLocalControlSession,
  request: AgentCodeRequest,
  text: string,
): Promise<string | undefined> {
  let body: unknown;
  const scope = {
    operationId: randomUUID(),
    threadId: request.answer.threadId,
    checkoutId: request.answer.checkoutId,
  };
  if (request.kind === "approval") {
    const opensThread = codeApprovalOpensThread(request);
    if (opensThread !== undefined) return opensThread;
    if (!/^(y|yes|n|no)$/i.test(text)) return "Answer the approval with y or n.";
    body = {
      kind: "answer-provider-approval",
      ...scope,
      approvalId: request.answer.approvalId,
      decision: /^(y|yes)$/i.test(text) ? "approved" : "denied",
    };
  } else {
    const selected = /^\d+$/.test(text) ? request.options[Number(text) - 1]?.label : undefined;
    const staged = await session.send({
      path: "/api/code/evidence",
      method: "PUT",
      bytes: new TextEncoder().encode(selected ?? text),
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-octant-code-thread-id": String(request.threadId),
      },
    });
    if (staged.status !== 200) return refusalMessage(staged, "The answer could not be staged.");
    body = {
      kind: "answer-provider-input",
      ...scope,
      requestId: request.answer.requestId,
      response: decodeHostAnswer(CodeEvidenceReference)(staged.body),
    };
  }
  const response = await session.send({ path: "/api/code/commands", method: "POST", body });
  const result =
    typeof response.body === "object" && response.body !== null ? response.body : undefined;
  const kind =
    result !== undefined && "kind" in result && typeof result.kind === "string"
      ? result.kind
      : undefined;
  const state =
    result !== undefined && "state" in result && typeof result.state === "string"
      ? result.state
      : undefined;
  const failureMessage =
    result !== undefined &&
    "failure" in result &&
    typeof result.failure === "object" &&
    result.failure !== null &&
    "message" in result.failure &&
    typeof result.failure.message === "string"
      ? result.failure.message
      : undefined;
  if (
    response.status !== 200 ||
    kind === undefined ||
    kind === "operation-failed" ||
    state === "failed" ||
    (state === "interrupted" && failureMessage !== undefined)
  )
    return refusalMessage(response, failureMessage ?? "The answer was refused.");
  return undefined;
}
