import {
  decodeChatCommand,
  decodeChatThreadWindowRequest,
  MAX_CHAT_NDJSON_LINE_BYTES,
  ChatAttachment,
  ChatBootstrap,
  ChatNavigation,
  type ChatCommand,
  ChatCommandResult,
  type ChatEventFrame,
  ChatFailure,
  type ChatThreadId,
  ChatThreadView,
  ChatThreadWindow,
  type ChatThreadWindowRequest,
  ChatTranscriptSearch,
  ChatThread,
  decodeHostAnswer,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";
import { ChatNdjsonFailure, iterateChatEventNdjson } from "./chatNdjsonStream";

export { MAX_CHAT_NDJSON_LINE_BYTES };

export interface ChatAttachmentUpload {
  readonly threadId: ChatThreadId;
  readonly attachmentId: ChatAttachment["id"];
  readonly displayName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ChatAttachmentDiscard {
  readonly threadId: ChatThreadId;
  readonly attachmentId: ChatAttachment["id"];
}

export interface ChatClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ChatClient {
  bootstrap(): Promise<ChatBootstrap>;
  navigation(): Promise<ChatNavigation>;
  search(query: string): Promise<ReadonlyArray<ChatBootstrap["threads"][number]>>;
  searchTranscript(query: string): Promise<ChatTranscriptSearch>;
  thread(threadId: ChatThreadId): Promise<ChatThreadView>;
  /**
   * One page of the thread's active turns: the newest, or the page before,
   * after, or ending with one turn. A host without the route answers 404,
   * which arrives as a failure whose `status` is 404; the caller then reads
   * `thread`.
   */
  threadWindow(
    threadId: ChatThreadId,
    request: ChatThreadWindowRequest,
    signal?: AbortSignal,
  ): Promise<ChatThreadWindow>;
  execute(command: ChatCommand): Promise<ChatCommandResult>;
  upload(input: ChatAttachmentUpload): Promise<ChatAttachment>;
  discard(input: ChatAttachmentDiscard): Promise<ChatAttachment>;
  subscribe(
    threadId: ChatThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<ChatEventFrame>;
}

export class ChatClientFailure extends Error {
  readonly category: ChatFailure["category"];
  /** The HTTP status when the host answered with one the client could not read as a failure. */
  readonly status: number | undefined;

  constructor(failure: ChatFailure, status?: number) {
    super(failure.message);
    this.name = "ChatClientFailure";
    this.category = failure.category;
    this.status = status;
  }
}

export function createChatClient(options: ChatClientOptions): ChatClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    bootstrap() {
      return request(
        fetch,
        new URL("/api/chat/bootstrap", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(ChatBootstrap),
      );
    },
    navigation() {
      return request(
        fetch,
        new URL("/api/chat/navigation", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(ChatNavigation),
      );
    },
    search(query) {
      const url = new URL("/api/chat/search", options.baseUrl);
      url.searchParams.set("q", query);
      return request(fetch, url.toString(), { method: "GET", headers }, decodeThreadArray);
    },
    searchTranscript(query) {
      const url = new URL("/api/chat/transcript-search", options.baseUrl);
      url.searchParams.set("q", query);
      return request(
        fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(ChatTranscriptSearch),
      );
    },
    thread(threadId) {
      return request(
        fetch,
        new URL(`/api/chat/threads/${encodeURIComponent(threadId)}`, options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(ChatThreadView),
      );
    },
    async threadWindow(threadId, windowRequest, signal) {
      let validated: ChatThreadWindowRequest;
      try {
        validated = decodeChatThreadWindowRequest(windowRequest);
      } catch {
        throw new ChatClientFailure({
          category: "invalid",
          message: "Chat window request is invalid.",
        });
      }
      const url = new URL(
        `/api/chat/threads/${encodeURIComponent(threadId)}/window`,
        options.baseUrl,
      );
      url.searchParams.set("limit", String(validated.limit));
      for (const anchor of ["before", "after", "through"] as const) {
        const turnId = validated[anchor];
        if (turnId !== undefined) url.searchParams.set(anchor, turnId);
      }
      const response = await requestRaw(fetch, url.toString(), {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      // An older host has no window route and answers its plain 404 page.
      if (response.status === 404) {
        throw new ChatClientFailure(
          { category: "unsupported", message: "This host has no Chat window read." },
          404,
        );
      }
      return readResponse(response, decodeHostAnswer(ChatThreadWindow));
    },
    async execute(command) {
      let validated: ChatCommand;
      try {
        validated = decodeChatCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        fetch,
        new URL("/api/chat/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeHostAnswer(ChatCommandResult),
      );
    },
    upload(input) {
      const bytes = new Uint8Array(input.bytes);
      return request(
        fetch,
        new URL("/api/chat/attachments", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": input.mediaType,
            "x-octant-chat-thread-id": String(input.threadId),
            "x-octant-chat-attachment-id": String(input.attachmentId),
            "x-octant-chat-display-name": encodeURIComponent(input.displayName),
          },
          body: bytes,
        },
        decodeHostAnswer(ChatAttachment),
      );
    },
    discard(input) {
      return request(
        fetch,
        new URL(
          `/api/chat/attachments/${encodeURIComponent(input.attachmentId)}`,
          options.baseUrl,
        ).toString(),
        {
          method: "DELETE",
          headers: {
            ...headers,
            "x-octant-chat-thread-id": String(input.threadId),
          },
        },
        decodeHostAnswer(ChatAttachment),
      );
    },
    subscribe(threadId, afterSequence, signal) {
      const url = new URL(
        `/api/chat/threads/${encodeURIComponent(threadId)}/events`,
        options.baseUrl,
      );
      url.searchParams.set("afterSequence", String(afterSequence));
      // Ask for the body behind each streamed delta so the thread view can
      // grow in place instead of re-reading the whole thread per frame.
      url.searchParams.set("contents", "1");
      // Ask for the receipt or failure of a compaction of the session as it ends.
      url.searchParams.set("compaction", "1");
      return parseNdjsonFrames(
        requestRaw(fetch, url.toString(), { method: "GET", headers, signal }),
        threadId,
        afterSequence,
        signal,
      );
    },
  };
}

async function* parseNdjsonFrames(
  responsePromise: Promise<Response>,
  threadId: ChatThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<ChatEventFrame> {
  const response = await responsePromise;
  if (!response.ok) {
    await rejectFailure(response);
  }
  try {
    yield* iterateChatEventNdjson(response, threadId, afterSequence, signal);
  } catch (error) {
    if (error instanceof ChatNdjsonFailure) {
      throw malformedResponse();
    }
    throw error;
  }
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  return readResponse(await requestRaw(fetch, url, init), decode);
}

async function readResponse<T>(response: Response, decode: (value: unknown) => T): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new ChatClientFailure(decodeHostAnswer(ChatFailure)(body));
    } catch (error) {
      if (error instanceof ChatClientFailure) throw error;
      throw malformedResponse();
    }
  }
  try {
    return decode(body);
  } catch {
    throw malformedResponse();
  }
}

async function requestRaw(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unavailable("Octant Chat service is unavailable.");
  }
}

async function rejectFailure(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
    throw new ChatClientFailure(decodeHostAnswer(ChatFailure)(body));
  } catch (error) {
    if (error instanceof ChatClientFailure) throw error;
    throw malformedResponse();
  }
}

function decodeThreadArray(value: unknown): ReadonlyArray<ChatBootstrap["threads"][number]> {
  if (!Array.isArray(value)) throw new Error("invalid");
  return value.map((item) => decodeHostAnswer(ChatThread)(item));
}

function unavailable(message: string): ChatClientFailure {
  return new ChatClientFailure({ category: "unavailable", message });
}

function invalidCommand(): ChatClientFailure {
  return new ChatClientFailure({ category: "invalid", message: "Chat command is invalid." });
}

function malformedResponse(): ChatClientFailure {
  return new ChatClientFailure({
    category: "unavailable",
    message: "Chat service returned an invalid response.",
  });
}
