import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
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
  decodeChatNavigation,
  decodeChatAttachment,
  decodeProviderRegistrySnapshot,
  type ChatNavigationThread,
  type NativeHarnessApprovalDecisionResult,
  type SteerNativeHarnessSession,
} from "@octant/contracts";
import { isNativeHarnessDriverKind } from "@octant/domain";
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
  extras: {
    readonly attachmentIds?: ReadonlyArray<string>;
    readonly threadMentionIds?: ReadonlyArray<string>;
  } = {},
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
      ...(extras.attachmentIds === undefined || extras.attachmentIds.length === 0
        ? {}
        : { attachmentIds: extras.attachmentIds }),
      ...(extras.threadMentionIds === undefined || extras.threadMentionIds.length === 0
        ? {}
        : { threadMentionIds: extras.threadMentionIds }),
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

/** Chat threads on the host, newest first. */
export async function listAgentThreads(
  session: OpenedLocalControlSession,
): Promise<ReadonlyArray<ChatNavigationThread>> {
  const response = await session.send({ path: "/api/chat/navigation", method: "GET" });
  if (response.status !== 200) return [];
  return [...decodeChatNavigation(response.body).threads].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
}

export interface AgentModelChoice {
  readonly instanceId: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextLimit: number | undefined;
}

/** Models a harness endpoint offers, endpoint by endpoint. */
export async function listAgentModels(
  session: OpenedLocalControlSession,
): Promise<ReadonlyArray<AgentModelChoice>> {
  const response = await session.send({ path: "/api/providers/bootstrap", method: "GET" });
  if (response.status !== 200) return [];
  const snapshot = decodeProviderRegistrySnapshot(response.body);
  const choices: AgentModelChoice[] = [];
  for (const instance of snapshot.instances) {
    if (!instance.enabled || !isNativeHarnessDriverKind(instance.driverKind)) continue;
    const observed = snapshot.observedStates.find(
      (state) => String(state.instanceId) === String(instance.id),
    );
    for (const model of observed?.models ?? []) {
      choices.push({
        instanceId: String(instance.id),
        endpoint: instance.displayName,
        modelId: String(model.id),
        displayName: model.displayName ?? String(model.id),
        contextLimit: model.contextLimit,
      });
    }
  }
  return choices;
}

export async function changeAgentModel(
  session: OpenedLocalControlSession,
  thread: ChatThreadView,
  choice: Pick<AgentModelChoice, "instanceId" | "modelId">,
): Promise<HostRefusal | { readonly kind: "changed" }> {
  const response = await session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "change-chat-provider",
      threadId: String(thread.thread.id),
      expectedVersion: thread.thread.version,
      providerInstanceId: choice.instanceId,
      modelId: choice.modelId,
    },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The model was not changed.") };
  }
  return { kind: "changed" };
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".log": "text/plain",
  ".json": "text/plain",
  ".csv": "text/plain",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".js": "text/plain",
  ".py": "text/plain",
  ".rs": "text/plain",
  ".go": "text/plain",
  ".css": "text/plain",
  ".html": "text/plain",
  ".yml": "text/plain",
  ".yaml": "text/plain",
  ".toml": "text/plain",
  ".sh": "text/plain",
};

export function attachmentMediaType(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()];
}

/** Stages a local file on the thread so the next prompt can carry it. */
export async function uploadAgentAttachment(
  session: OpenedLocalControlSession,
  threadId: string,
  path: string,
): Promise<HostRefusal | { readonly kind: "uploaded"; readonly attachmentId: string }> {
  const mediaType = attachmentMediaType(path);
  if (mediaType === undefined) {
    return { kind: "refused", message: `${basename(path)} is not a file type a thread can carry.` };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return { kind: "refused", message: `${path} could not be read.` };
  }
  const attachmentId = randomUUID();
  const response = await session.send({
    path: "/api/chat/attachments",
    method: "POST",
    bytes,
    headers: {
      "content-type": mediaType,
      "x-octant-chat-thread-id": threadId,
      "x-octant-chat-attachment-id": attachmentId,
      "x-octant-chat-display-name": encodeURIComponent(basename(path)),
    },
  });
  if (response.status !== 200) {
    return {
      kind: "refused",
      message: refusalMessage(response, `${basename(path)} was not accepted.`),
    };
  }
  return { kind: "uploaded", attachmentId: String(decodeChatAttachment(response.body).id) };
}

/** How much of the model's window the last turn used, when the model says how big it is. */
export function contextPercent(
  thread: ChatThreadView | undefined,
  models: ReadonlyArray<AgentModelChoice>,
): number | undefined {
  if (thread === undefined) return undefined;
  const limit = models.find(
    (choice) =>
      choice.instanceId === String(thread.thread.providerInstanceId) &&
      choice.modelId === String(thread.thread.modelId),
  )?.contextLimit;
  const used = thread.turns.at(-1)?.attempts.at(-1)?.usage?.inputTokens;
  if (limit === undefined || used === undefined || limit <= 0) return undefined;
  return Math.min(100, Math.round((used / limit) * 100));
}
