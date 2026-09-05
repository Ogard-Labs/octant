import { randomUUID } from "node:crypto";
import {
  decodeChatThreadView,
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessSessionView,
  type ChatThreadView,
  type NativeHarnessFollowUpActivationResult,
  type NativeHarnessFollowUpPreview,
  type NativeHarnessSessionView,
  decodeNativeHarnessApprovalDecisionResult,
  type NativeHarnessApprovalDecisionResult,
  type SteerNativeHarnessSession,
} from "@octant/contracts";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * The host calls both terminal front ends make for one thread: the
 * line-mode `octant agent` and the terminal UI read and steer the same
 * thread through the same routes the app uses.
 */
export type HostRefusal = { readonly kind: "refused"; readonly message: string };

export function refusalMessage(
  response: { readonly status: number; readonly body: unknown },
  fallback: string,
): string {
  const body = response.body;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.length > 0) return record.message;
    const failure = record.failure;
    if (typeof failure === "object" && failure !== null) {
      const message = (failure as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return fallback;
}

const sessionsPath = (threadId: string) =>
  `/api/native-harness/sessions/${encodeURIComponent(threadId)}`;

export async function readAgentThread(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<ChatThreadView | undefined> {
  const response = await session.send({
    path: `/api/chat/threads/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) return undefined;
  return decodeChatThreadView(response.body);
}

export async function readAgentSession(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<NativeHarnessSessionView | null | "unavailable"> {
  const response = await session.send({ path: sessionsPath(threadId), method: "GET" });
  if (response.status !== 200) return "unavailable";
  const view = (response.body as { view?: unknown }).view;
  return view === null || view === undefined ? null : decodeNativeHarnessSessionView(view);
}

export async function sendAgentPrompt(
  session: OpenedLocalControlSession,
  thread: ChatThreadView,
  prompt: string,
): Promise<HostRefusal | { readonly kind: "sent" }> {
  const sent = await session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "send-chat-turn",
      threadId: String(thread.thread.id),
      expectedVersion: thread.thread.version,
      prompt,
      submissionId: randomUUID(),
    },
  });
  if (sent.status !== 200) {
    return { kind: "refused", message: refusalMessage(sent, "The host refused the turn.") };
  }
  return { kind: "sent" };
}

export async function answerAgentQuestion(
  session: OpenedLocalControlSession,
  threadId: string,
  questionId: string,
  answer: string,
): Promise<HostRefusal | { readonly kind: "answered" }> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/questions`,
    method: "POST",
    body: { questionId, answer },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The answer was refused.") };
  }
  return { kind: "answered" };
}

export async function commandAgentSession(
  session: OpenedLocalControlSession,
  view: NativeHarnessSessionView,
  action: "pause" | "resume",
): Promise<HostRefusal | { readonly kind: "done" }> {
  const response = await session.send({
    path: `${sessionsPath(String(view.session.threadId))}/commands`,
    method: "POST",
    body: {
      kind: action === "pause" ? "pause-native-harness-session" : "resume-native-harness-session",
      sessionId: String(view.session.id),
      expectedVersion: view.session.version,
    },
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, `The session could not be ${action}d.`),
    };
  }
  return { kind: "done" };
}

export async function previewAgentFollowUp(
  session: OpenedLocalControlSession,
  threadId: string,
  suggestionId: string,
): Promise<
  HostRefusal | { readonly kind: "previewed"; readonly preview: NativeHarnessFollowUpPreview }
> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/follow-ups/preview`,
    method: "POST",
    body: { suggestionId },
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, "The follow-up could not be previewed."),
    };
  }
  return {
    kind: "previewed",
    preview: decodeNativeHarnessFollowUpPreview((response.body as { preview?: unknown }).preview),
  };
}

export async function activateAgentFollowUp(
  session: OpenedLocalControlSession,
  threadId: string,
  turnId: string,
  suggestionId: string,
): Promise<NativeHarnessFollowUpActivationResult> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/follow-ups/activate`,
    method: "POST",
    body: { turnId, suggestionId, confirmed: true },
  });
  return decodeNativeHarnessFollowUpActivationResult(response.body);
}

/** The latest assistant reply, from the content the latest attempt references. */
export function latestReplyText(view: ChatThreadView): string {
  const attempt = view.turns.at(-1)?.attempts.at(-1);
  if (attempt === undefined) return "";
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  return attempt.responseRefs.map((ref) => bodies.get(String(ref.contentId)) ?? "").join("");
}

/** Stops the turn in flight; a thread with nothing running is left alone. */
export async function interruptAgentTurn(
  session: OpenedLocalControlSession,
  thread: ChatThreadView,
): Promise<HostRefusal | { readonly kind: "interrupted" } | { readonly kind: "nothing-running" }> {
  const turn = thread.turns.at(-1);
  const attempt = turn?.attempts.at(-1);
  if (
    turn === undefined ||
    attempt === undefined ||
    (attempt.outcome !== "streaming" &&
      attempt.outcome !== "queued" &&
      attempt.outcome !== "waiting")
  ) {
    return { kind: "nothing-running" };
  }
  const response = await session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "interrupt-chat-turn",
      threadId: String(thread.thread.id),
      expectedVersion: thread.thread.version,
      turnId: String(turn.id),
      attemptId: String(attempt.id),
    },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The turn could not be stopped.") };
  }
  return { kind: "interrupted" };
}

export async function decideAgentApproval(
  session: OpenedLocalControlSession,
  threadId: string,
  approvalId: string,
  decision: "approve" | "approve-always" | "deny",
): Promise<NativeHarnessApprovalDecisionResult> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/approvals`,
    method: "POST",
    body: { approvalId, decision },
  });
  return decodeNativeHarnessApprovalDecisionResult(response.body);
}

export async function steerAgent(
  session: OpenedLocalControlSession,
  threadId: string,
  command: SteerNativeHarnessSession,
): Promise<HostRefusal | { readonly kind: "steered" }> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/steering`,
    method: "POST",
    body: command,
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The note was not queued.") };
  }
  return { kind: "steered" };
}

export function isAgentTurnRunning(thread: ChatThreadView | undefined): boolean {
  const outcome = thread?.turns.at(-1)?.attempts.at(-1)?.outcome;
  return outcome === "streaming" || outcome === "queued" || outcome === "waiting";
}
