import {
  decodeChatAttachment,
  decodeChatBootstrap,
  decodeChatCommandResult,
  decodeChatThreadView,
  decodeCodeBootstrap,
  decodeCodeBoardView,
  decodeWorkThreadBootstrap,
  type ChatAttachment,
  type ChatEventFrame,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadView,
  type CodeBoardView,
  type CodeThread,
  type CodeThreadReviewState,
  type WorkThread,
} from "@octant/contracts";
import { ChatNdjsonFailure, iterateChatEventNdjson } from "./chatNdjsonStream";

export type MobileInboxMode = "chat" | "work" | "code";
export type MobileCodeReviewState = CodeThreadReviewState["state"];

export interface MobileInboxRow {
  readonly hostId: string;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly freshness: string;
  readonly reviewState?: MobileCodeReviewState;
}

export interface MobileRemoteTransport {
  readonly hostId: string;
  readonly authenticatedFetch: (input: {
    readonly method: string;
    readonly path: string;
    readonly query?: string;
    readonly body?: string | Uint8Array;
    readonly headers?: Record<string, string>;
    readonly signal?: AbortSignal;
    readonly contentType?: string;
  }) => Promise<Response>;
}

export class MobileInboxFailure extends Error {
  readonly category: "offline" | "rejected" | "unavailable" | "stale";

  constructor(category: MobileInboxFailure["category"], message: string) {
    super(message);
    this.name = "MobileInboxFailure";
    this.category = category;
  }
}

async function decodeJson<T>(
  response: Response,
  decode: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  try {
    return decode(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      `${failureMessage} The host returned an invalid response.`,
    );
  }
}

function chatRow(hostId: string, thread: ChatThread): MobileInboxRow {
  return {
    hostId,
    mode: "chat",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
  };
}

function workRow(hostId: string, thread: WorkThread): MobileInboxRow {
  return {
    hostId,
    mode: "work",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
  };
}

function codeRow(
  hostId: string,
  thread: CodeThread,
  reviewState?: MobileCodeReviewState,
): MobileInboxRow {
  return {
    hostId,
    mode: "code",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
    ...(reviewState === undefined ? {} : { reviewState }),
  };
}

interface MobileInboxBootstrapRows {
  readonly hostId: string;
  readonly chatThreads: ReadonlyArray<ChatThread>;
  readonly workThreads: ReadonlyArray<WorkThread>;
  readonly codeThreads: ReadonlyArray<CodeThread>;
}

export function sortMobileInboxRows(
  rows: ReadonlyArray<MobileInboxRow>,
): ReadonlyArray<MobileInboxRow> {
  return [...rows].sort((left, right) => {
    if (left.freshness === right.freshness) {
      return left.threadId.localeCompare(right.threadId);
    }
    return left.freshness < right.freshness ? 1 : -1;
  });
}

export function normalizeMobileInbox(input: {
  readonly hostId: string;
  readonly chatThreads: ReadonlyArray<ChatThread>;
  readonly workThreads: ReadonlyArray<WorkThread>;
  readonly codeThreads: ReadonlyArray<CodeThread>;
  readonly codeReviewStates?: ReadonlyMap<string, MobileCodeReviewState>;
}): ReadonlyArray<MobileInboxRow> {
  return sortMobileInboxRows([
    ...input.chatThreads.map((thread) => chatRow(input.hostId, thread)),
    ...input.workThreads.map((thread) => workRow(input.hostId, thread)),
    ...input.codeThreads.map((thread) =>
      codeRow(input.hostId, thread, input.codeReviewStates?.get(String(thread.id))),
    ),
  ]);
}

export async function fetchMobileCodeBoard(
  transport: MobileRemoteTransport,
): Promise<CodeBoardView> {
  return decodeJson(
    await transport.authenticatedFetch({
      method: "POST",
      path: "/api/code/board",
      body: JSON.stringify({ version: 1 }),
    }),
    decodeCodeBoardView,
    "Code Board state could not be loaded from the host.",
  );
}

async function fetchMobileInboxBootstrapRows(
  transport: MobileRemoteTransport,
): Promise<MobileInboxBootstrapRows> {
  const [chatResponse, workResponse, codeResponse] = await Promise.all([
    transport.authenticatedFetch({ method: "GET", path: "/api/chat/bootstrap" }),
    transport.authenticatedFetch({ method: "GET", path: "/api/work/threads/bootstrap" }),
    transport.authenticatedFetch({ method: "GET", path: "/api/code/bootstrap" }),
  ]);

  const chat = await decodeJson(
    chatResponse,
    decodeChatBootstrap,
    "Chat bootstrap failed over the remote session.",
  );
  const work = await decodeJson(
    workResponse,
    decodeWorkThreadBootstrap,
    "Work bootstrap failed over the remote session.",
  );
  const code = await decodeJson(
    codeResponse,
    decodeCodeBootstrap,
    "Code bootstrap failed over the remote session.",
  );

  return {
    hostId: transport.hostId,
    chatThreads: chat.threads,
    workThreads: work.threads,
    codeThreads: code.threads,
  };
}

function rowsFromMobileInboxBootstrap(
  input: MobileInboxBootstrapRows,
  board?: CodeBoardView,
): ReadonlyArray<MobileInboxRow> {
  return normalizeMobileInbox({
    ...input,
    ...(board === undefined
      ? {}
      : {
          codeReviewStates: new Map(
            board.cards.map((card) => [String(card.threadId), card.reviewState.state]),
          ),
        }),
  });
}

/** Fan-out Chat/Work/Code bootstraps over an authenticated remote transport. */
export async function listMobileInbox(
  transport: MobileRemoteTransport,
): Promise<ReadonlyArray<MobileInboxRow>> {
  const inboxInput = await fetchMobileInboxBootstrapRows(transport);
  const board = await fetchMobileCodeBoard(transport);
  return rowsFromMobileInboxBootstrap(inboxInput, board);
}

export interface MobileInboxHostFailure {
  readonly hostId: string;
  readonly category: MobileInboxFailure["category"];
  readonly message: string;
}

export interface AllHostsMobileInbox {
  readonly rows: ReadonlyArray<MobileInboxRow>;
  readonly failures: ReadonlyArray<MobileInboxHostFailure>;
}

/**
 * Client-side All Hosts fan-out. One host's failure never clears another host's
 * rows; failures are returned for honest partial-availability UI.
 */
export async function listAllHostsMobileInbox(
  transports: ReadonlyArray<MobileRemoteTransport>,
): Promise<AllHostsMobileInbox> {
  if (transports.length === 0) return { rows: [], failures: [] };

  const settled = await Promise.allSettled(
    transports.map(async (transport) => {
      const inboxInput = await fetchMobileInboxBootstrapRows(transport);
      try {
        const board = await fetchMobileCodeBoard(transport);
        return { hostId: transport.hostId, rows: rowsFromMobileInboxBootstrap(inboxInput, board) };
      } catch (reason) {
        if (!(reason instanceof MobileInboxFailure)) throw reason;
        return {
          hostId: transport.hostId,
          rows: rowsFromMobileInboxBootstrap(inboxInput),
          failure: {
            hostId: transport.hostId,
            category: reason.category,
            message: reason.message,
          } satisfies MobileInboxHostFailure,
        };
      }
    }),
  );

  const rows: MobileInboxRow[] = [];
  const failures: MobileInboxHostFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const hostId = transports[index]!.hostId;
    if (result.status === "fulfilled") {
      rows.push(...result.value.rows);
      if (result.value.failure !== undefined) failures.push(result.value.failure);
      continue;
    }
    const reason = result.reason;
    if (reason instanceof MobileInboxFailure) {
      failures.push({ hostId, category: reason.category, message: reason.message });
    } else {
      failures.push({
        hostId,
        category: "unavailable",
        message: "Could not load threads from this host.",
      });
    }
  }

  return { rows: sortMobileInboxRows(rows), failures };
}

export async function loadMobileChatThread(
  transport: MobileRemoteTransport,
  threadId: string,
): Promise<ChatThreadView> {
  const response = await transport.authenticatedFetch({
    method: "GET",
    path: `/api/chat/threads/${encodeURIComponent(threadId)}`,
  });
  return decodeJson(response, decodeChatThreadView, "Chat thread load failed.");
}

function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (line.length === 0) return "New chat";
  if (line.length <= 72) return line;
  return `${line.slice(0, 71).trimEnd()}…`;
}

/**
 * Create a Chat thread on the host. Same authoritative journal/SQLite path as
 * desktop — the phone never keeps a separate thread store.
 */
export async function createMobileChatThread(input: {
  readonly transport: MobileRemoteTransport;
  readonly title: string;
  readonly threadId?: string;
}): Promise<ChatThread> {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new MobileInboxFailure("unavailable", "Chat title is required.");
  }
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/commands",
    body: JSON.stringify({
      kind: "create-chat-thread",
      threadId: input.threadId ?? globalThis.crypto.randomUUID(),
      title,
    }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not create a Chat thread on the host.",
    );
  }
  let result: ReturnType<typeof decodeChatCommandResult>;
  try {
    result = decodeChatCommandResult(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Chat create returned an invalid response from the host.",
    );
  }
  if (result.kind !== "thread-created") {
    throw new MobileInboxFailure("unavailable", "Host did not confirm Chat thread creation.");
  }
  return result.thread;
}

/**
 * Apply a host-advertised provider/model to an existing Chat thread before the
 * next turn. Returns the updated thread (version bumped).
 */
export async function changeMobileChatProvider(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly providerInstanceId: string;
  readonly modelId: string;
}): Promise<ChatThread> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/commands",
    body: JSON.stringify({
      kind: "change-chat-provider",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
    }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      response.status === 409
        ? "Thread changed on the host. Refresh and try again."
        : "Could not change the Chat model on the host.",
    );
  }
  let result: ReturnType<typeof decodeChatCommandResult>;
  try {
    result = decodeChatCommandResult(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Chat provider change returned an invalid response from the host.",
    );
  }
  if (result.kind !== "thread-updated") {
    throw new MobileInboxFailure("unavailable", "Host did not confirm the Chat model change.");
  }
  return result.thread;
}

/**
 * Create a Chat thread on the placement host and send the first user turn —
 * same host-owned data the desktop Inbox sees. Optional provider/model is
 * applied via `change-chat-provider` after create (create itself uses host
 * Chat settings defaults).
 */
export async function createMobileChatWithFirstTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly prompt: string;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
}): Promise<MobileInboxRow> {
  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) {
    throw new MobileInboxFailure("unavailable", "Prompt text is required.");
  }
  let thread = await createMobileChatThread({
    transport: input.transport,
    title: titleFromPrompt(trimmed),
  });
  if (
    input.providerInstanceId !== undefined &&
    input.modelId !== undefined &&
    (thread.providerInstanceId !== input.providerInstanceId || thread.modelId !== input.modelId)
  ) {
    thread = await changeMobileChatProvider({
      transport: input.transport,
      threadId: thread.id,
      expectedVersion: thread.version,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
    });
  }
  await sendMobileChatTurn({
    transport: input.transport,
    threadId: thread.id,
    expectedVersion: thread.version,
    prompt: trimmed,
  });
  const view = await loadMobileChatThread(input.transport, thread.id);
  return chatRow(input.transport.hostId, view.thread);
}

export async function sendMobileChatTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly prompt: string;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly attachmentIds?: ReadonlyArray<string>;
}): Promise<void> {
  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) {
    throw new MobileInboxFailure("unavailable", "Follow-up text is required.");
  }
  let expectedVersion = input.expectedVersion;
  if (input.providerInstanceId !== undefined && input.modelId !== undefined) {
    const updated = await changeMobileChatProvider({
      transport: input.transport,
      threadId: input.threadId,
      expectedVersion,
      providerInstanceId: input.providerInstanceId,
      modelId: input.modelId,
    });
    expectedVersion = updated.version;
  }
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/commands",
    body: JSON.stringify({
      kind: "send-chat-turn",
      threadId: input.threadId,
      expectedVersion,
      prompt: trimmed,
      ...(input.attachmentIds === undefined || input.attachmentIds.length === 0
        ? {}
        : { attachmentIds: [...input.attachmentIds] }),
    }),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      response.status === 409
        ? "Thread changed on the host. Refresh and try again."
        : "Chat follow-up was rejected by the host.",
    );
  }
}

async function postChatThreadCommand(input: {
  readonly transport: MobileRemoteTransport;
  readonly body: Record<string, unknown>;
  readonly rejectedMessage: string;
}): Promise<void> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/commands",
    body: JSON.stringify(input.body),
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      response.status === 409
        ? "Thread changed on the host. Refresh and try again."
        : input.rejectedMessage,
    );
  }
}

/** Interrupt an in-flight Chat attempt on the host (Stop). */
export async function interruptMobileChatTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
}): Promise<void> {
  await postChatThreadCommand({
    transport: input.transport,
    body: {
      kind: "interrupt-chat-turn",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      turnId: input.turnId,
      attemptId: input.attemptId,
    },
    rejectedMessage: "Could not stop the Chat turn on the host.",
  });
}

/** Retry a failed or interrupted Chat attempt on the host. */
export async function retryMobileChatTurn(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly turnId: string;
  readonly attemptId: string;
}): Promise<void> {
  await postChatThreadCommand({
    transport: input.transport,
    body: {
      kind: "retry-chat-turn",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      turnId: input.turnId,
      attemptId: input.attemptId,
    },
    rejectedMessage: "Could not retry the Chat turn on the host.",
  });
}

/**
 * Subscribe to host Chat event NDJSON. Callers should refresh the thread view
 * after each frame (same pattern as web useChatController).
 */
export async function* subscribeMobileChatEvents(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly afterSequence: number;
  readonly signal: AbortSignal;
}): AsyncGenerator<ChatEventFrame> {
  const response = await input.transport.authenticatedFetch({
    method: "GET",
    path: `/api/chat/threads/${encodeURIComponent(input.threadId)}/events`,
    query: `?afterSequence=${encodeURIComponent(String(input.afterSequence))}`,
    signal: input.signal,
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not subscribe to Chat events on the host.",
    );
  }
  try {
    yield* iterateChatEventNdjson(
      response,
      input.threadId as ChatThreadId,
      input.afterSequence,
      input.signal,
    );
  } catch (error) {
    if (error instanceof ChatNdjsonFailure) {
      throw new MobileInboxFailure("unavailable", error.message);
    }
    throw error;
  }
}

/** Upload a Chat attachment (image/pdf/text) to the host. */
export async function uploadMobileChatAttachment(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}): Promise<ChatAttachment> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: "/api/chat/attachments",
    body: input.bytes,
    contentType: input.mediaType,
    headers: {
      "x-octant-chat-thread-id": input.threadId,
      "x-octant-chat-attachment-id": input.attachmentId,
      "x-octant-chat-display-name": encodeURIComponent(input.displayName),
    },
  });
  if (!response.ok) {
    throw new MobileInboxFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Could not upload the attachment to the host.",
    );
  }
  try {
    return decodeChatAttachment(await response.json());
  } catch {
    throw new MobileInboxFailure(
      "unavailable",
      "Attachment upload returned an invalid response from the host.",
    );
  }
}

export async function completeMobileChatWorkItem(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly itemId: string;
}): Promise<void> {
  await postChatThreadCommand({
    transport: input.transport,
    body: {
      kind: "complete-chat-work-item",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      itemId: input.itemId,
    },
    rejectedMessage: "Could not complete the work item on the host.",
  });
}

export async function cancelMobileChatWorkItem(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly itemId: string;
}): Promise<void> {
  await postChatThreadCommand({
    transport: input.transport,
    body: {
      kind: "cancel-chat-work-item",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      itemId: input.itemId,
    },
    rejectedMessage: "Could not cancel the work item on the host.",
  });
}

export async function completeMobileChatFollowUp(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly expectedVersion: number;
  readonly acknowledgedThroughSequence: number;
}): Promise<void> {
  await postChatThreadCommand({
    transport: input.transport,
    body: {
      kind: "complete-chat-follow-up",
      threadId: input.threadId,
      expectedVersion: input.expectedVersion,
      acknowledgedThroughSequence: input.acknowledgedThroughSequence,
    },
    rejectedMessage: "Could not complete the follow-up on the host.",
  });
}
