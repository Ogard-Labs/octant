import {
  CHAT_ATTACHMENT_MEDIA_TYPES,
  decodeChatAttachmentId,
  decodeChatCommand,
  decodeChatEventFrame,
  decodeChatFailure,
  decodeChatThreadId,
  MAX_CHAT_NDJSON_LINE_BYTES,
  GlobalSequence,
  type ChatAttachment,
  type ChatBootstrap,
  type ChatCommandResult,
  type ChatEventFrame,
  type ChatFailure,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadView,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { MAX_CHAT_ATTACHMENT_BYTES } from "./chat/chatAttachmentStore";
import { ChatServiceError, type ChatService } from "./chat/chatService";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "DELETE, GET, POST, OPTIONS";
const HEADERS =
  "content-type, x-octant-window-capability, x-octant-chat-thread-id, x-octant-chat-attachment-id, x-octant-chat-display-name";
const SUPPORTED_ATTACHMENT_MEDIA_TYPES = new Set<string>(CHAT_ATTACHMENT_MEDIA_TYPES);
const MAX_REPLAY_FRAMES = 100;
const decodeGlobalSequence = Schema.decodeUnknownSync(GlobalSequence);

export interface ChatRouteDependencies {
  readonly service: ChatService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly maxAttachmentBodySize?: number;
  readonly now?: () => number;
}

export function createChatRouteHandler(dependencies: ChatRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  const attachmentLimit = dependencies.maxAttachmentBodySize ?? MAX_CHAT_ATTACHMENT_BYTES;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/chat/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "unsupported", message: "Chat API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isBootstrap = url.pathname === "/api/chat/bootstrap";
    const isNavigation = url.pathname === "/api/chat/navigation";
    const isSearch = url.pathname === "/api/chat/search";
    const isTranscriptSearch = url.pathname === "/api/chat/transcript-search";
    const isCommands = url.pathname === "/api/chat/commands";
    const isAttachments = url.pathname === "/api/chat/attachments";
    const threadMatch = /^\/api\/chat\/threads\/([^/]+)$/.exec(url.pathname);
    const eventsMatch = /^\/api\/chat\/threads\/([^/]+)\/events$/.exec(url.pathname);
    const attachmentMatch = /^\/api\/chat\/attachments\/([^/]+)$/.exec(url.pathname);
    const isThread = threadMatch !== null;
    const isEvents = eventsMatch !== null;
    const isAttachmentRead = attachmentMatch !== null;
    if (
      !isBootstrap &&
      !isNavigation &&
      !isSearch &&
      !isTranscriptSearch &&
      !isCommands &&
      !isAttachments &&
      !isThread &&
      !isEvents &&
      !isAttachmentRead
    ) {
      return undefined;
    }

    let commandBody: Awaited<ReturnType<typeof readJsonBody>> | undefined;
    if (isCommands) {
      commandBody = await readJsonBody(request, jsonLimit);
      if (commandBody.kind === "too-large") {
        return failureResponse(
          { category: "invalid", message: "Request body is too large." },
          413,
          origin,
        );
      }
      if (commandBody.kind === "invalid") {
        return failureResponse(
          { category: "invalid", message: "Command body must be valid JSON." },
          400,
          origin,
        );
      }
    }

    let authenticatedWindowId;
    try {
      authenticatedWindowId = authenticateChatRequest({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(commandBody?.kind === "ok" ? { body: commandBody.value } : {}),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { category: "unauthorized", message: "Chat request is unauthorized." },
          401,
          origin,
        );
      }
      if (error instanceof ChatRouteRejected) {
        return failureResponse(
          { category: "invalid", message: error.message },
          error.status,
          origin,
        );
      }
      return failureResponse(
        { category: "invalid", message: "Chat request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isBootstrap) {
        if (request.method !== "GET" || url.search !== "") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(await dependencies.service.bootstrap(), 200, origin);
      }
      if (isNavigation) {
        if (request.method !== "GET" || url.search !== "") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(dependencies.service.navigation(), 200, origin);
      }
      if (isSearch) {
        if (request.method !== "GET") {
          return failureResponse(
            { category: "unsupported", message: "HTTP method is not supported for this route." },
            400,
            origin,
          );
        }
        if ([...url.searchParams.keys()].some((key) => key !== "q")) {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(
          dependencies.service.search(url.searchParams.get("q") ?? ""),
          200,
          origin,
        );
      }

      if (isTranscriptSearch) {
        if (request.method !== "GET") {
          return failureResponse(
            { category: "unsupported", message: "HTTP method is not supported for this route." },
            400,
            origin,
          );
        }
        if ([...url.searchParams.keys()].some((key) => key !== "q")) {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(
          dependencies.service.searchTranscript(url.searchParams.get("q") ?? ""),
          200,
          origin,
        );
      }
      if (isThread) {
        if (request.method !== "GET" || url.search !== "") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        let threadId: ChatThreadId;
        try {
          threadId = decodeChatThreadId(decodeURIComponent(threadMatch![1] ?? ""));
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat thread ID is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(dependencies.service.read(threadId), 200, origin);
      }
      if (isEvents) {
        if (request.method !== "GET") {
          return failureResponse(
            { category: "unsupported", message: "HTTP method is not supported for this route." },
            400,
            origin,
          );
        }
        let threadId: ChatThreadId;
        try {
          threadId = decodeChatThreadId(decodeURIComponent(eventsMatch![1] ?? ""));
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat thread ID is invalid." },
            400,
            origin,
          );
        }
        const afterSequenceParam = url.searchParams.get("afterSequence");
        if (afterSequenceParam === null || url.searchParams.size !== 1) {
          return failureResponse(
            { category: "invalid", message: "Chat replay cursor is invalid." },
            400,
            origin,
          );
        }
        let afterSequence: number;
        try {
          afterSequence = decodeGlobalSequence(Number(afterSequenceParam));
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat replay cursor is invalid." },
            400,
            origin,
          );
        }
        return ndjsonStreamResponse(
          (signal) => dependencies.service.subscribe(threadId, afterSequence, signal),
          request.signal,
          origin,
        );
      }
      if (isCommands) {
        if (request.method !== "POST" || url.search !== "" || commandBody?.kind !== "ok") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        let command;
        try {
          command = decodeChatCommand(commandBody.value);
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat command is invalid." },
            400,
            origin,
          );
        }
        return jsonResponse(
          await dependencies.service.execute(command, { windowId: authenticatedWindowId }),
          200,
          origin,
        );
      }
      if (isAttachments) {
        if (request.method !== "POST" || url.search !== "") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        const upload = await readAttachmentUpload(request, attachmentLimit);
        if (upload.kind === "too-large") {
          return failureResponse(
            { category: "invalid", message: "Attachment body is too large." },
            413,
            origin,
          );
        }
        if (upload.kind === "invalid") {
          return failureResponse({ category: "invalid", message: upload.message }, 400, origin);
        }
        const attachment = await dependencies.service.uploadAttachment({
          ...upload.value,
          signal: request.signal,
        });
        return jsonResponse(attachment, 200, origin);
      }
      if (isAttachmentRead) {
        if ((request.method !== "GET" && request.method !== "DELETE") || url.search !== "") {
          return failureResponse(
            { category: "invalid", message: "Chat request is invalid." },
            400,
            origin,
          );
        }
        let attachmentId;
        try {
          attachmentId = decodeChatAttachmentId(decodeURIComponent(attachmentMatch![1] ?? ""));
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat attachment ID is invalid." },
            400,
            origin,
          );
        }
        let threadId: ChatThreadId;
        try {
          threadId = decodeStrictThreadHeader(request.headers.get("x-octant-chat-thread-id"));
        } catch {
          return failureResponse(
            { category: "invalid", message: "Chat attachment thread is invalid." },
            400,
            origin,
          );
        }
        if (request.method === "DELETE") {
          return jsonResponse(
            await dependencies.service.discardAttachment(threadId, attachmentId),
            200,
            origin,
          );
        }
        const bytes = await dependencies.service.readAttachment(threadId, attachmentId);
        const metadata = findAttachmentMetadata(dependencies.service.read(threadId), attachmentId);
        return new Response(Buffer.from(bytes), {
          status: 200,
          headers: {
            ...Object.fromEntries(corsHeaders(origin).entries()),
            "content-type": metadata?.mediaType ?? "application/octet-stream",
            "content-length": String(bytes.byteLength),
          },
        });
      }
      return undefined;
    } catch (error) {
      if (error instanceof ChatRouteRejected) {
        return failureResponse(
          { category: "invalid", message: error.message },
          error.status,
          origin,
        );
      }
      if (error instanceof ChatServiceError) return failureResponse(error.failure, origin);
      return failureResponse(
        { category: "unavailable", message: "Octant Chat service is unavailable." },
        503,
        origin,
      );
    }
  };
}

class ChatRouteRejected extends Error {
  override readonly message: string;

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.message = message;
    this.name = "ChatRouteRejected";
  }
}

export function authenticateChatRequest(input: {
  readonly request: Request;
  readonly store: WindowAuthorityStore;
  readonly now: number;
  readonly body?: unknown;
}): WindowId {
  try {
    return authenticateRouteWindowId({
      request: input.request,
      store: input.store,
      now: input.now,
      body: input.body,
    });
  } catch (error) {
    if (error instanceof WindowAuthorityError) {
      throw new ChatRouteRejected(
        error.category === "invalid"
          ? "Chat requests cannot supply window identity."
          : error.message,
        error.category === "invalid" ? 400 : 401,
      );
    }
    throw error;
  }
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

async function readAttachmentUpload(
  request: Request,
  maxBytes: number,
): Promise<
  | {
      kind: "ok";
      value: {
        threadId: ChatThreadId;
        attachmentId: ChatAttachment["id"];
        displayName: string;
        mediaType: string;
        bytes: Uint8Array;
      };
    }
  | { kind: "too-large" }
  | { kind: "invalid"; message: string }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  let threadId: ChatThreadId;
  let attachmentId: ChatAttachment["id"];
  let displayName: string;
  let mediaType: string;
  try {
    threadId = decodeStrictThreadHeader(request.headers.get("x-octant-chat-thread-id"));
    attachmentId = decodeChatAttachmentId(request.headers.get("x-octant-chat-attachment-id") ?? "");
    const encodedDisplayName = request.headers.get("x-octant-chat-display-name");
    if (encodedDisplayName === null || encodedDisplayName === "") {
      throw new Error("missing display name");
    }
    displayName = decodeURIComponent(encodedDisplayName);
    if (displayName !== encodedDisplayName && !/^[\w .()-]+$/.test(displayName)) {
      throw new Error("invalid display name");
    }
    mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!SUPPORTED_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      return { kind: "invalid", message: "Attachment media type is unsupported." };
    }
  } catch {
    return { kind: "invalid", message: "Chat attachment metadata is invalid." };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { kind: "too-large" };
  return { kind: "ok", value: { threadId, attachmentId, displayName, mediaType, bytes } };
}

function decodeStrictThreadHeader(value: string | null): ChatThreadId {
  if (value === null || value === "") throw new Error("missing thread id");
  return decodeChatThreadId(value);
}

function findAttachmentMetadata(
  view: ChatThreadView,
  attachmentId: ChatAttachment["id"],
): ChatAttachment | undefined {
  return view.attachments.find((attachment) => String(attachment.id) === String(attachmentId));
}

function failureResponse(failure: ChatFailure, origin: string | null): Response;
function failureResponse(failure: ChatFailure, status: number, origin: string | null): Response;
function failureResponse(
  failure: ChatFailure,
  statusOrOrigin: number | string | null,
  maybeOrigin?: string | null,
): Response {
  const status =
    typeof statusOrOrigin === "number"
      ? statusOrOrigin
      : failure.category === "unauthorized"
        ? 401
        : failure.category === "stale"
          ? 409
          : failure.category === "unsupported"
            ? 400
            : failure.category === "unavailable" || failure.category === "waiting"
              ? 503
              : 400;
  const origin = typeof statusOrOrigin === "number" ? (maybeOrigin ?? null) : statusOrOrigin;
  return jsonResponse(decodeChatFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function ndjsonStreamResponse(
  frames: (signal: AbortSignal) => AsyncIterable<ChatEventFrame>,
  requestSignal: AbortSignal,
  origin: string | null,
): Response {
  const streamAbort = new AbortController();
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<ChatEventFrame> | undefined;
  const abort = () => streamAbort.abort();
  requestSignal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          iterator = frames(streamAbort.signal)[Symbol.asyncIterator]();
          let emitted = 0;
          while (!streamAbort.signal.aborted && emitted < MAX_REPLAY_FRAMES) {
            const next = await iterator.next();
            if (next.done) break;
            controller.enqueue(encoder.encode(serializeNdjsonFrame(next.value)));
            emitted += 1;
          }
          if (!streamAbort.signal.aborted) controller.close();
        } catch (error) {
          if (!streamAbort.signal.aborted) controller.error(error);
        } finally {
          requestSignal.removeEventListener("abort", abort);
          await iterator?.return?.();
        }
      })();
    },
    async cancel() {
      streamAbort.abort();
      requestSignal.removeEventListener("abort", abort);
      await iterator?.return?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...Object.fromEntries(corsHeaders(origin).entries()),
      "content-type": "application/x-ndjson",
    },
  });
}

function serializeNdjsonFrame(frame: ChatEventFrame): string {
  const line = `${JSON.stringify(decodeChatEventFrame(frame))}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CHAT_NDJSON_LINE_BYTES) {
    throw new ChatRouteRejected("Chat replay frame is too large.", 400);
  }
  return line;
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

export type { ChatBootstrap, ChatCommandResult, ChatThread };
