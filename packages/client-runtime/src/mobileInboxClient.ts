import {
  type ChatEventFrame,
  type ChatThread,
  type ChatThreadId,
  ChatThreadView,
  CodeBoardView,
  type CodeThread,
  type CodeThreadReviewState,
  type WorkThread,
  ChatBootstrap,
  ChatCommandResult,
  CodeBootstrap,
  WorkThreadBootstrap,
  decodeHostAnswer,
} from "@octant/contracts";
import { ParseResult } from "effect";
import {
  MAX_WAITING_ASK_TEXT_LENGTH,
  PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE,
  PendingRequest,
  WaitingAsk,
  type WaitingAskKind,
} from "@octant/contracts/pending-requests";
import { ChatNdjsonFailure, iterateChatEventNdjson } from "./chatNdjsonStream";

export type MobileInboxMode = "chat" | "work" | "code";
export type MobileCodeReviewState = CodeThreadReviewState["state"];

/**
 * What the host's runtime sidecar says a thread is doing now: a turn running,
 * or a running turn parked on the person. Absent means the host reported
 * neither, which is idle, not unknown-and-therefore-working.
 */
export type MobileThreadLiveState = "working" | "needs-input";

export interface MobileThreadRuntimeReport {
  readonly threadId: string;
  readonly executing: boolean;
  readonly awaitingInput?: boolean | undefined;
}

/**
 * A waiting ask as a row names it: what kind of ask, and the host's own line
 * about it when this build could read one. A row only finds the ask; its
 * thread's own card answers it.
 */
export interface MobileWaitingAsk {
  readonly label: string;
  readonly text?: string;
}

/** How a row's detail line names its waiting ask. */
export function mobileWaitingAskLine(ask: MobileWaitingAsk): string {
  return ask.text === undefined ? ask.label : `${ask.label}: ${ask.text}`;
}

export interface MobileInboxRow {
  readonly hostId: string;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly freshness: string;
  readonly reviewState?: MobileCodeReviewState;
  /** The thread's Project; a Chat with no folder has none. */
  readonly projectId?: string;
  readonly pinned?: boolean;
  readonly live?: MobileThreadLiveState;
  /** The oldest approval, question or other ask the host says waits on the person here. */
  readonly waitingAsk?: MobileWaitingAsk;
  /** The thread's aggregate version, which a row action sends as its expected version. */
  readonly version?: number;
  /** Put away (completed) at this time; absent while the thread is on the active list. */
  readonly completedAt?: string;
  readonly snooze?: { readonly until: string; readonly at: string; readonly duringTurn?: boolean };
}

function restFields(thread: {
  readonly version: number;
  readonly completedAt?: string | undefined;
  readonly snooze?:
    | { readonly until: string; readonly at: string; readonly duringTurn?: boolean | undefined }
    | undefined;
}): Pick<MobileInboxRow, "version" | "completedAt" | "snooze"> {
  return {
    version: thread.version,
    ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
    ...(thread.snooze === undefined
      ? {}
      : {
          snooze: {
            until: thread.snooze.until,
            at: thread.snooze.at,
            ...(thread.snooze.duringTurn === true ? { duringTurn: true } : {}),
          },
        }),
  };
}

/** The live state a runtime report gives, if any. */
export function mobileThreadLiveState(
  report: MobileThreadRuntimeReport | undefined,
): MobileThreadLiveState | undefined {
  if (report === undefined) return undefined;
  if (report.awaitingInput === true) return "needs-input";
  return report.executing ? "working" : undefined;
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
  readonly category: "offline" | "rejected" | "unavailable" | "stale" | "incompatible";

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
  } catch (cause) {
    if (ParseResult.isParseError(cause)) {
      throw new MobileInboxFailure(
        "incompatible",
        `${failureMessage} The host sent thread data this app version can't read. Update the app or the host.`,
      );
    }
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
    ...restFields(thread),
    ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
  };
}

function workRow(hostId: string, thread: WorkThread, live?: MobileThreadLiveState): MobileInboxRow {
  return {
    hostId,
    mode: "work",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
    projectId: String(thread.projectId),
    ...restFields(thread),
    ...(live === undefined ? {} : { live }),
  };
}

function codeRow(
  hostId: string,
  thread: CodeThread,
  reviewState?: MobileCodeReviewState,
  live?: MobileThreadLiveState,
): MobileInboxRow {
  return {
    hostId,
    mode: "code",
    threadId: thread.id,
    title: thread.title,
    status: thread.lifecycle,
    freshness: thread.updatedAt,
    projectId: String(thread.projectId),
    ...restFields(thread),
    ...(thread.pinned === true ? { pinned: true } : {}),
    ...(reviewState === undefined ? {} : { reviewState }),
    ...(live === undefined ? {} : { live }),
  };
}

interface MobileInboxBootstrapRows {
  readonly hostId: string;
  readonly chatThreads: ReadonlyArray<ChatThread>;
  readonly workThreads: ReadonlyArray<WorkThread>;
  readonly codeThreads: ReadonlyArray<CodeThread>;
  readonly workRuntime?: ReadonlyArray<MobileThreadRuntimeReport>;
  readonly codeRuntime?: ReadonlyArray<MobileThreadRuntimeReport>;
  readonly failure?: MobileInboxFailure;
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
  readonly workRuntime?: ReadonlyArray<MobileThreadRuntimeReport>;
  readonly codeRuntime?: ReadonlyArray<MobileThreadRuntimeReport>;
}): ReadonlyArray<MobileInboxRow> {
  const reportFor = (
    reports: ReadonlyArray<MobileThreadRuntimeReport> | undefined,
    threadId: string,
  ) => reports?.find((report) => String(report.threadId) === threadId);
  return sortMobileInboxRows([
    ...input.chatThreads.map((thread) => chatRow(input.hostId, thread)),
    ...input.workThreads.map((thread) =>
      workRow(
        input.hostId,
        thread,
        mobileThreadLiveState(reportFor(input.workRuntime, String(thread.id))),
      ),
    ),
    ...input.codeThreads.map((thread) =>
      codeRow(
        input.hostId,
        thread,
        input.codeReviewStates?.get(String(thread.id)),
        mobileThreadLiveState(reportFor(input.codeRuntime, String(thread.id))),
      ),
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
    decodeHostAnswer(CodeBoardView),
    "Code Board state could not be loaded from the host.",
  );
}

async function fetchMobileInboxBootstrapRows(
  transport: MobileRemoteTransport,
): Promise<MobileInboxBootstrapRows> {
  const settled = await Promise.allSettled([
    transport.authenticatedFetch({ method: "GET", path: "/api/chat/bootstrap" }),
    transport.authenticatedFetch({ method: "GET", path: "/api/work/threads/bootstrap" }),
    transport.authenticatedFetch({ method: "GET", path: "/api/code/bootstrap" }),
  ]);
  const failures: MobileInboxFailure[] = [];
  const decodeBootstrap = async <T>(
    result: PromiseSettledResult<Response>,
    decode: (value: unknown) => T,
    message: string,
  ): Promise<T | undefined> => {
    try {
      if (result.status === "rejected") throw result.reason;
      return await decodeJson(result.value, decode, message);
    } catch (cause) {
      const failure =
        cause instanceof MobileInboxFailure
          ? cause
          : new MobileInboxFailure("unavailable", `${message} The host could not be reached.`);
      failures.push(failure);
      return undefined;
    }
  };
  const chat = await decodeBootstrap(
    settled[0],
    decodeHostAnswer(ChatBootstrap),
    "Chat bootstrap failed over the remote session.",
  );
  const work = await decodeBootstrap(
    settled[1],
    decodeHostAnswer(WorkThreadBootstrap),
    "Work bootstrap failed over the remote session.",
  );
  const code = await decodeBootstrap(
    settled[2],
    decodeHostAnswer(CodeBootstrap),
    "Code bootstrap failed over the remote session.",
  );

  return {
    hostId: transport.hostId,
    chatThreads: chat?.threads ?? [],
    workThreads: work?.threads ?? [],
    codeThreads: code?.threads ?? [],
    workRuntime: work?.runtime ?? [],
    codeRuntime: code?.runtime ?? [],
    ...(failures[0] === undefined ? {} : { failure: failures[0] }),
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

const WAITING_ASK_LABELS: Readonly<Record<WaitingAskKind, string>> = {
  "tool-approval": "Tool approval",
  "memory-proposal": "Memory proposal",
  "routine-proposal": "Routine proposal",
  "image-offer": "Image offer",
  "service-offer": "Offer",
  "browser-approval": "Browser approval",
  "browser-sign-in": "Browser sign-in",
};

const PENDING_REQUEST_LABELS: Readonly<Record<PendingRequest["kind"], string>> = {
  approval: "Approval",
  question: "Question",
  decision: "Decision",
  "child-approval": "Subagent approval",
  "child-question": "Subagent question",
  "lead-approval": "Approval",
  "lead-question": "Question",
};

/** What a row says for an ask this app version does not know. */
const UNKNOWN_ASK_LABEL = "Waiting on you";

interface MobileListedAsk {
  readonly mode: MobileInboxMode;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly requestedAt: string;
  readonly projectId?: string;
  readonly ask: MobileWaitingAsk;
}

const decodePendingRequestItem = decodeHostAnswer(PendingRequest);
const decodeWaitingAskItem = decodeHostAnswer(WaitingAsk);

function listedAsk(
  item: {
    readonly mode: MobileInboxMode;
    readonly threadId: string;
    readonly threadTitle: string;
    readonly requestedAt: string;
    readonly projectId?: string | undefined;
  },
  ask: MobileWaitingAsk,
): MobileListedAsk {
  return {
    mode: item.mode,
    threadId: String(item.threadId),
    threadTitle: item.threadTitle,
    requestedAt: item.requestedAt,
    ...(item.projectId === undefined ? {} : { projectId: String(item.projectId) }),
    ask,
  };
}

/**
 * An item this build cannot decode still names a thread the person is waited
 * on in, so it is listed by its thread alone and opens it. Nothing it says
 * beyond the host's one line is shown, and no list answers it.
 */
function unknownAsk(item: unknown): MobileListedAsk | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const fields = item as Readonly<Record<string, unknown>>;
  const mode = fields["mode"];
  const threadId = fields["threadId"];
  if (mode !== "chat" && mode !== "work" && mode !== "code") return undefined;
  if (typeof threadId !== "string" || threadId.trim().length === 0) return undefined;
  const text = fields["text"];
  const title = fields["threadTitle"];
  const requestedAt = fields["requestedAt"];
  const projectId = fields["projectId"];
  return {
    mode,
    threadId,
    threadTitle: typeof title === "string" && title.trim().length > 0 ? title : "Thread",
    requestedAt: typeof requestedAt === "string" ? requestedAt : "",
    ...(typeof projectId === "string" ? { projectId } : {}),
    ask: {
      label: UNKNOWN_ASK_LABEL,
      ...(typeof text === "string" && text.trim().length > 0
        ? { text: text.trim().slice(0, MAX_WAITING_ASK_TEXT_LENGTH) }
        : {}),
    },
  };
}

function pendingRequestAsk(item: unknown): MobileListedAsk | undefined {
  try {
    const request = decodePendingRequestItem(item);
    const label =
      request.mode === "code" && request.kind === "approval" && request.browserOrigin !== undefined
        ? WAITING_ASK_LABELS["browser-approval"]
        : PENDING_REQUEST_LABELS[request.kind];
    return listedAsk(request, { label, text: request.text });
  } catch {
    return unknownAsk(item);
  }
}

function waitingAskItem(item: unknown): MobileListedAsk | undefined {
  try {
    const ask = decodeWaitingAskItem(item);
    return listedAsk(ask, { label: WAITING_ASK_LABELS[ask.kind], text: ask.text });
  } catch {
    return unknownAsk(item);
  }
}

/**
 * Every approval, question, decision and other waiting ask the host lists for
 * this device, the oldest per thread. Each item is read on its own, so one
 * kind a newer host adds lists that thread under a generic label instead of
 * hiding every other ask the list holds.
 */
async function readMobileWaitingAsks(
  transport: MobileRemoteTransport,
): Promise<ReadonlyMap<string, MobileListedAsk>> {
  const asks = new Map<string, MobileListedAsk>();
  try {
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/pending-requests",
      headers: { accept: PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE },
    });
    if (!response.ok) return asks;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return asks;
    const { requests, asks: otherAsks } = body as Readonly<Record<string, unknown>>;
    const listed = [
      ...(Array.isArray(requests) ? requests.map(pendingRequestAsk) : []),
      ...(Array.isArray(otherAsks) ? otherAsks.map(waitingAskItem) : []),
    ];
    for (const entry of listed) {
      if (entry === undefined) continue;
      const key = `${entry.mode}:${entry.threadId}`;
      const held = asks.get(key);
      if (held === undefined || entry.requestedAt < held.requestedAt) asks.set(key, entry);
    }
  } catch {
    // An older or restricted host may not offer this read at all.
  }
  return asks;
}

/**
 * A thread a waiting ask names that the bootstraps did not list (its mode's
 * bootstrap failed, or it changed between the reads) is still listed, from
 * the ask's own thread title, so the ask is never hidden.
 */
function askOnlyRow(hostId: string, entry: MobileListedAsk): MobileInboxRow {
  return {
    hostId,
    mode: entry.mode,
    threadId: entry.threadId,
    title: entry.threadTitle,
    status: "active",
    freshness: entry.requestedAt,
    ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
    live: "needs-input",
    waitingAsk: entry.ask,
  };
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
      const [inboxInput, waitingAsks] = await Promise.all([
        fetchMobileInboxBootstrapRows(transport),
        readMobileWaitingAsks(transport),
      ]);
      const rowsWithOffers = (board?: CodeBoardView): ReadonlyArray<MobileInboxRow> => {
        const unlisted = new Map(waitingAsks);
        const rows = rowsFromMobileInboxBootstrap(inboxInput, board).map((row) => {
          const key = `${row.mode}:${row.threadId}`;
          const entry = waitingAsks.get(key);
          if (entry === undefined) return row;
          unlisted.delete(key);
          return { ...row, live: "needs-input" as const, waitingAsk: entry.ask };
        });
        return [
          ...rows,
          ...[...unlisted.values()].map((entry) => askOnlyRow(transport.hostId, entry)),
        ];
      };
      try {
        const board = await fetchMobileCodeBoard(transport);
        return {
          hostId: transport.hostId,
          rows: rowsWithOffers(board),
          ...(inboxInput.failure === undefined
            ? {}
            : {
                failure: {
                  hostId: transport.hostId,
                  category: inboxInput.failure.category,
                  message: inboxInput.failure.message,
                } satisfies MobileInboxHostFailure,
              }),
        };
      } catch (reason) {
        if (!(reason instanceof MobileInboxFailure)) throw reason;
        return {
          hostId: transport.hostId,
          rows: rowsWithOffers(),
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
    const transport = transports[index];
    if (transport === undefined) continue;
    const hostId = transport.hostId;
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
  return decodeJson(response, decodeHostAnswer(ChatThreadView), "Chat thread load failed.");
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
  let result: ChatCommandResult;
  try {
    result = decodeHostAnswer(ChatCommandResult)(await response.json());
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
  let result: ChatCommandResult;
  try {
    result = decodeHostAnswer(ChatCommandResult)(await response.json());
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
  /**
   * Told as soon as the host has made the thread, before its first turn: a
   * turn that then fails to start still leaves a thread the caller can name.
   */
  readonly onCreated?: (row: MobileInboxRow) => void;
}): Promise<MobileInboxRow> {
  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) {
    throw new MobileInboxFailure("unavailable", "Prompt text is required.");
  }
  let thread = await createMobileChatThread({
    transport: input.transport,
    title: titleFromPrompt(trimmed),
  });
  input.onCreated?.(chatRow(input.transport.hostId, thread));
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
