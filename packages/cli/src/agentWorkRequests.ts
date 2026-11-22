import { decodeHostAnswer } from "@octant/contracts";
import { PendingRequest } from "@octant/contracts/pending-requests";
import type { OpenedLocalControlSession } from "./localControl";
import { refusalMessage } from "./agentHost";

export type AgentWorkRequest = Extract<
  PendingRequest,
  { mode: "work"; kind: "approval" | "question" }
>;
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
    const requests = rows.flatMap((row: unknown) => {
      const request = decodeHostAnswer(PendingRequest)(row);
      return request.mode === "work" &&
        String(request.threadId) === threadId &&
        (request.kind === "approval" || request.kind === "question")
        ? [request]
        : [];
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
  let resolution:
    | { readonly kind: "approval"; readonly approved: boolean }
    | {
        readonly kind: "user-input";
        readonly answer: string;
      };
  if (request.kind === "approval") {
    if (!/^(y|yes|n|no)$/i.test(text)) return "Answer the approval with y or n.";
    resolution = { kind: "approval", approved: /^(y|yes)$/i.test(text) };
  } else {
    const selected = /^\d+$/.test(text) ? request.options[Number(text) - 1]?.label : undefined;
    resolution = { kind: "user-input", answer: selected ?? text };
  }
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
