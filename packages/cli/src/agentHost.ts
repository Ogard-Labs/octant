import { approvalOutsideContentLines } from "@octant/domain";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  ChatThreadView,
  NativeHarnessFollowUpActivationResult,
  NativeHarnessFollowUpPreview,
  NativeHarnessSessionView,
  type ChatNavigationThread,
  type DecideNativeHarnessApproval,
  type NativeHarnessApproval,
  type NativeHarnessCommandHost,
  type NativeHarnessCommandHostChoice,
  NativeHarnessApprovalDecisionResult,
  type SteerNativeHarnessSession,
  type NativeHarnessSteeringNote,
  type SideChatSidecar,
  ThreadGoal,
  ChatNavigation,
  ChatAttachment,
  ProviderRegistrySnapshot,
  NativeHarnessSteeringTaken,
  ThreadMentionCommandResult,
  decodeHostAnswer,
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
    // The harness session and goal routes name their refusal `error`.
    if (typeof record.error === "string" && record.error.length > 0) return record.error;
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
  return decodeHostAnswer(ChatThreadView)(response.body);
}

export async function readAgentSession(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<NativeHarnessSessionView | null | "unavailable"> {
  const response = await session.send({ path: sessionsPath(threadId), method: "GET" });
  if (response.status !== 200) return "unavailable";
  const view = (response.body as { view?: unknown }).view;
  return view === null || view === undefined
    ? null
    : decodeHostAnswer(NativeHarnessSessionView)(view);
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

/**
 * Answers the question a Chat turn is parked on, through the same command the
 * app's transcript card sends. The host refuses it when the thread moved on or
 * the question was answered first, and the refusal says so.
 */
export async function answerAgentTurnQuestion(
  session: OpenedLocalControlSession,
  thread: ChatThreadView,
  question: {
    readonly turnId: string;
    readonly attemptId: string;
    readonly requestId: string;
    readonly answer: string;
  },
): Promise<HostRefusal | { readonly kind: "answered" }> {
  const response = await session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "answer-chat-turn-question",
      threadId: String(thread.thread.id),
      expectedVersion: thread.thread.version,
      turnId: question.turnId,
      attemptId: question.attemptId,
      requestId: question.requestId,
      answer: question.answer,
    },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The answer was refused.") };
  }
  return { kind: "answered" };
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
    preview: decodeHostAnswer(NativeHarnessFollowUpPreview)(
      (response.body as { preview?: unknown }).preview,
    ),
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
  return decodeHostAnswer(NativeHarnessFollowUpActivationResult)(response.body);
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

/**
 * Whether an approval may be answered "for this session". The host remembers
 * only a lead's request on a thread that has taken in no outside content, and
 * turns any other session-wide answer into a single approval, so a surface
 * that offers it would promise what the host does not give.
 */
export function approvalMayBeRemembered(
  approval: Pick<NativeHarnessApproval, "source" | "singleUse">,
): boolean {
  return approval.source === undefined && approval.singleUse !== true;
}

/**
 * The lines an approval prints ahead of its question when the thread took in
 * outside content: why it asks and each source that marked the thread. Empty
 * for an approval on a clean thread.
 */
export function approvalOutsideContentText(
  approval: Pick<NativeHarnessApproval, "outsideContent">,
): ReadonlyArray<string> {
  if (approval.outsideContent === undefined) return [];
  const { reason, rows, more } = approvalOutsideContentLines(approval.outsideContent, (at) => {
    if (at === undefined) return undefined;
    const parsed = new Date(at);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString();
  });
  return [
    reason,
    ...rows.map((row) => `  - ${row.name}: ${row.reads}`),
    ...(more ? [`  ${more}`] : []),
  ];
}

/**
 * A marked thread's command lists the hosts it may reach. The host ticks its
 * thread and Project rules and leaves its proposals unticked; these are the
 * positions (from 0) it ticked.
 */
export function preselectedCommandHosts(
  approval: Pick<NativeHarnessApproval, "commandHosts">,
): ReadonlySet<number> {
  const ticked = new Set<number>();
  approval.commandHosts?.forEach((entry, index) => {
    if (entry.preselected) ticked.add(index);
  });
  return ticked;
}

/**
 * Reads the hosts a person names by their number in the list: `1 3`, `1,3`,
 * or `none`. Anything else, a number the list does not have included, reads
 * as nothing chosen at all, so a typo never sends a host the person did not
 * mean.
 */
export function readCommandHostNumbers(
  text: string,
  count: number,
): ReadonlySet<number> | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "none") return new Set();
  const parts = trimmed.split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const chosen = new Set<number>();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const number = Number(part);
    if (number < 1 || number > count) return undefined;
    chosen.add(number - 1);
  }
  return chosen;
}

/** The listed hosts at the ticked positions, as the host takes them back. */
export function chosenCommandHosts(
  approval: Pick<NativeHarnessApproval, "commandHosts">,
  ticked: ReadonlySet<number>,
): ReadonlyArray<NativeHarnessCommandHostChoice> {
  return (approval.commandHosts ?? [])
    .filter((_entry, index) => ticked.has(index))
    .map((entry) => ({ host: entry.host, port: entry.port }));
}

const COMMAND_HOST_ORIGIN: Record<NativeHarnessCommandHost["from"], string> = {
  "thread-rule": "thread rule",
  "project-rule": "Project rule",
  proposal: "proposal",
};

/** One line per listed host: its tick, number, host and port, and where it came from. */
export function commandHostLines(
  approval: Pick<NativeHarnessApproval, "commandHosts">,
  ticked: ReadonlySet<number>,
): ReadonlyArray<string> {
  return (approval.commandHosts ?? []).map(
    (entry, index) =>
      `[${ticked.has(index) ? "x" : " "}] ${String(index + 1)}. ${entry.host}:${String(entry.port)}  ${COMMAND_HOST_ORIGIN[entry.from]}`,
  );
}

/**
 * The approval's answer. Hosts go only with "approve" on an approval that
 * listed them; the command reaches the ones sent and nothing else.
 */
export function approvalDecisionBody(
  approval: Pick<NativeHarnessApproval, "id" | "commandHosts">,
  decision: "approve" | "approve-always" | "deny",
  commandHosts: ReadonlyArray<NativeHarnessCommandHostChoice> = [],
): DecideNativeHarnessApproval {
  return {
    approvalId: approval.id,
    decision,
    ...(approval.commandHosts !== undefined && decision === "approve" ? { commandHosts } : {}),
  };
}

export async function decideAgentApproval(
  session: OpenedLocalControlSession,
  threadId: string,
  body: DecideNativeHarnessApproval,
): Promise<NativeHarnessApprovalDecisionResult> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/approvals`,
    method: "POST",
    body,
  });
  return decodeHostAnswer(NativeHarnessApprovalDecisionResult)(response.body);
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

/**
 * Takes every queued note for this client to send as the next prompt. The
 * host empties the queue in the same step, so another client watching the
 * same turn end gets none of them and cannot send them twice.
 */
export async function takeAgentSteering(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<
  HostRefusal | { readonly kind: "taken"; readonly notes: ReadonlyArray<NativeHarnessSteeringNote> }
> {
  const response = await session.send({
    path: `${sessionsPath(threadId)}/steering`,
    method: "POST",
    body: { kind: "take" },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The notes could not be taken.") };
  }
  return {
    kind: "taken",
    notes: decodeHostAnswer(NativeHarnessSteeringTaken)(response.body).taken,
  };
}

/**
 * The thread's Side Chat, opened by the host: one read-only Chat thread about
 * this thread, the same one the app's Side Chat panel shows. It can read the
 * source but never message, steer, or approve it.
 */
export async function openAgentSideChat(
  session: OpenedLocalControlSession,
  sourceThreadId: string,
): Promise<HostRefusal | { readonly kind: "opened"; readonly sidecar: SideChatSidecar }> {
  const requestId = randomUUID();
  const response = await session.send({
    path: "/api/thread-mentions/commands",
    method: "POST",
    body: { kind: "open-side-chat", requestId, sourceThreadId },
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "Side Chat could not open.") };
  }
  const result = decodeHostAnswer(ThreadMentionCommandResult)(response.body);
  if (result.kind === "side-chat-opened") return { kind: "opened", sidecar: result.sidecar };
  return {
    kind: "refused",
    message:
      result.kind === "failed" && result.reason === "unsupported-mode"
        ? "This thread has no Side Chat."
        : result.kind === "failed" && result.reason === "unavailable"
          ? "Side Chat is unavailable on this host right now."
          : "Side Chat could not open for this thread.",
  };
}

export async function readAgentGoal(
  session: OpenedLocalControlSession,
  threadId: string,
): Promise<HostRefusal | { readonly kind: "goal"; readonly goal: ThreadGoal | null }> {
  const response = await session.send({
    path: `/api/goals?threadId=${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    return { kind: "refused", message: refusalMessage(response, "The goal could not be read.") };
  }
  const goal = (response.body as { readonly goal?: unknown } | undefined)?.goal;
  return {
    kind: "goal",
    goal: goal === null || goal === undefined ? null : decodeHostAnswer(ThreadGoal)(goal),
  };
}

/**
 * Revises the goal's objective against the version this client read. A goal
 * another client changed first is refused as `stale`, never overwritten, so
 * the person sees the newer goal before deciding again.
 */
export async function reviseAgentGoal(
  session: OpenedLocalControlSession,
  goal: ThreadGoal,
  objective: string,
): Promise<HostRefusal | { readonly kind: "stale" } | { readonly kind: "revised" }> {
  const response = await session.send({
    path: "/api/goals/commands",
    method: "POST",
    body: {
      kind: "revise-thread-goal",
      threadId: String(goal.threadId),
      expectedVersion: goal.version,
      goalId: String(goal.id),
      revisionId: randomUUID(),
      objective,
    },
  });
  if (response.status === 200) return { kind: "revised" };
  const category = (response.body as { readonly category?: unknown } | undefined)?.category;
  if (response.status === 409 && category === "stale") return { kind: "stale" };
  return { kind: "refused", message: refusalMessage(response, "The goal was not revised.") };
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
  return [...decodeHostAnswer(ChatNavigation)(response.body).threads].sort((a, b) =>
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
  const snapshot = decodeHostAnswer(ProviderRegistrySnapshot)(response.body);
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
  return {
    kind: "uploaded",
    attachmentId: String(decodeHostAnswer(ChatAttachment)(response.body).id),
  };
}

/** How much of the model's window the last turn used, when the model says how big it is. */
export function contextPercent(
  thread:
    | {
        readonly providerInstanceId: string;
        readonly modelId: string;
        readonly turns: ReadonlyArray<{ readonly inputTokens?: number }>;
      }
    | undefined,
  models: ReadonlyArray<AgentModelChoice>,
): number | undefined {
  if (thread === undefined) return undefined;
  const limit = models.find(
    (choice) =>
      choice.instanceId === thread.providerInstanceId && choice.modelId === thread.modelId,
  )?.contextLimit;
  const used = thread.turns.at(-1)?.inputTokens;
  if (limit === undefined || used === undefined || limit <= 0) return undefined;
  return Math.min(100, Math.round((used / limit) * 100));
}
