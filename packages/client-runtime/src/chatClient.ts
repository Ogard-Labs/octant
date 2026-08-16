import {
  decodeChatAttachment,
  decodeChatBootstrap,
  decodeChatCommand,
  decodeChatCommandResult,
  decodeChatFailure,
  decodeChatThread,
  decodeChatThreadView,
  MAX_CHAT_NDJSON_LINE_BYTES,
  type ChatAttachment,
  type ChatBootstrap,
  type ChatCommand,
  type ChatCommandResult,
  type ChatEventFrame,
  type ChatFailure,
  type ChatThreadId,
  type ChatThreadView,
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
  search(query: string): Promise<ReadonlyArray<ChatBootstrap["threads"][number]>>;
  thread(threadId: ChatThreadId): Promise<ChatThreadView>;
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

  constructor(failure: ChatFailure) {
    super(failure.message);
    this.name = "ChatClientFailure";
    this.category = failure.category;
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
        decodeChatBootstrap,
      );
    },
    search(query) {
      const url = new URL("/api/chat/search", options.baseUrl);
      url.searchParams.set("q", query);
      return request(fetch, url.toString(), { method: "GET", headers }, decodeThreadArray);
    },
    thread(threadId) {
      return request(
        fetch,
        new URL(`/api/chat/threads/${encodeURIComponent(threadId)}`, options.baseUrl).toString(),
        { method: "GET", headers },
        decodeChatThreadView,
      );
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
        decodeChatCommandResult,
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
        decodeChatAttachment,
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
        decodeChatAttachment,
      );
    },
    subscribe(threadId, afterSequence, signal) {
      const url = new URL(
        `/api/chat/threads/${encodeURIComponent(threadId)}/events`,
        options.baseUrl,
      );
      url.searchParams.set("afterSequence", String(afterSequence));
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
  const response = await requestRaw(fetch, url, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new ChatClientFailure(decodeChatFailure(body));
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
    throw new ChatClientFailure(decodeChatFailure(body));
  } catch (error) {
    if (error instanceof ChatClientFailure) throw error;
    throw malformedResponse();
  }
}

function decodeThreadArray(value: unknown): ReadonlyArray<ChatBootstrap["threads"][number]> {
  if (!Array.isArray(value)) throw new Error("invalid");
  return value.map((item) => decodeChatThread(item));
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
