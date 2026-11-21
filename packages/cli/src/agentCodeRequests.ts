import { randomUUID } from "node:crypto";
import { CodeEvidenceReference, decodeHostAnswer } from "@octant/contracts";
import { PendingRequest } from "@octant/contracts/pending-requests";
import type { OpenedLocalControlSession } from "./localControl";
import { refusalMessage } from "./agentHost";

export type AgentCodeRequest = Extract<
  PendingRequest,
  { mode: "code"; kind: "approval" | "question" }
>;
export function codeRequestId(request: AgentCodeRequest): string {
  return request.kind === "approval"
    ? String(request.answer.approvalId)
    : String(request.answer.requestId);
}
export async function readCodeRequests(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<readonly AgentCodeRequest[]> {
  const response = await session.send({ path: "/api/pending-requests", method: "GET" });
  if (response.status !== 200) throw new Error("Provider requests are unavailable.");
  const rows =
    typeof response.body === "object" && response.body !== null && "requests" in response.body
      ? response.body.requests
      : undefined;
  if (!Array.isArray(rows)) throw new Error("Invalid provider request list.");
  return rows.flatMap((row: unknown) => {
    const request = decodeHostAnswer(PendingRequest)(row);
    return request.mode === "code" &&
      String(request.threadId) === threadId &&
      (request.kind === "question" ||
        (request.kind === "approval" && request.browserOrigin === undefined))
      ? [request]
      : [];
  });
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
