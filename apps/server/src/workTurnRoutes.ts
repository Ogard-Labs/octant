import {
  MAX_WORK_ATTACHMENT_BYTES,
  WorkTurnFailure as WorkTurnFailureSchema,
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeWorkAttachmentReference,
  decodeWorkThreadId,
  decodeWorkThreadTranscript,
  decodeWorkTurnStreamFrame,
  decodeWorkTurnCancelResult,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnFailure,
  type WorkTurnLookupResult,
  type WorkTurnStreamFrame,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { WorkTurnServiceError } from "./work/workTurnService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const HEADERS =
  "content-type, x-octant-window-capability, x-octant-work-thread-id, x-octant-work-attachment-id, x-octant-work-display-name";
const decodeWorkTurnFailure = Schema.decodeUnknownSync(WorkTurnFailureSchema);

export interface WorkTurnRouteService {
  readonly startFirstTurn: (windowId: WindowId, command: unknown) => Promise<WorkTurnLookupResult>;
  readonly lookupFirstTurn: (
    windowId: WindowId,
    requestId: string,
  ) => Promise<WorkTurnLookupResult>;
  readonly cancelFirstTurn: (windowId: WindowId, command: unknown) => Promise<WorkTurnCancelResult>;
  readonly transcript: (
    windowId: WindowId,
    threadId: WorkThreadId,
  ) => Promise<WorkThreadTranscript>;
  readonly subscribe: (
    windowId: WindowId,
    threadId: WorkThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ) => AsyncIterable<WorkTurnStreamFrame>;
  readonly stageAttachment?: (
    windowId: WindowId,
    input: {
      readonly threadId: WorkThreadId;
      readonly attachmentId: WorkAttachmentId;
      readonly displayName: string;
      readonly mediaType: WorkAttachmentMediaType;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ) => Promise<WorkAttachmentReference>;
  readonly discardAttachment?: (
    windowId: WindowId,
    threadId: WorkThreadId,
    attachmentId: WorkAttachmentId,
  ) => Promise<void>;
}

export interface WorkTurnRouteDependencies {
  readonly service: WorkTurnRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly maxFileBodySize?: number;
  readonly now?: () => number;
}

export function createWorkTurnRouteHandler(dependencies: WorkTurnRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  const fileLimit = dependencies.maxFileBodySize ?? MAX_WORK_ATTACHMENT_BYTES;

  async function handleAttachment(
    request: Request,
    url: URL,
    authenticatedWindowId: WindowId,
    origin: string | null,
  ): Promise<Response> {
    const service = dependencies.service;
    if (service.stageAttachment === undefined || service.discardAttachment === undefined) {
      return failureResponse(
        { category: "unavailable", message: "Work attachments are unavailable." },
        503,
        origin,
      );
    }
    if (request.method === "PUT") {
      if (url.search !== "") {
        throw new WorkTurnRouteRejected("Work turn request is invalid.", 400);
      }
      const upload = readAttachmentUpload(request);
      const bytes = await readBoundedBytes(request, fileLimit);
      return jsonResponse(
        decodeWorkAttachmentReference(
          await service.stageAttachment(authenticatedWindowId, {
            ...upload,
            bytes,
            signal: request.signal,
          }),
        ),
        200,
        origin,
      );
    }
    if (request.method === "DELETE") {
      const target = readAttachmentTarget(url);
      await service.discardAttachment(authenticatedWindowId, target.threadId, target.attachmentId);
      return jsonResponse({ status: "discarded" }, 200, origin);
    }
    throw new WorkTurnRouteRejected("Work turn request is invalid.", 400);
  }

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/work/turns") && url.pathname !== "/api/work/attachments") {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "unsupported", message: "Work turn API requests must use loopback." },
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

    const isAttachment = url.pathname === "/api/work/attachments";
    const isStart = url.pathname === "/api/work/turns" && request.method === "POST";
    const isCancel = url.pathname === "/api/work/turns/cancel" && request.method === "POST";
    const lookupMatch = url.pathname.match(/^\/api\/work\/turns\/([^/]+)$/);
    const isLookup = lookupMatch !== null && request.method === "GET";
    const transcriptMatch = url.pathname.match(/^\/api\/work\/turns\/transcript\/([^/]+)$/);
    const isTranscript = transcriptMatch !== null && request.method === "GET";
    const streamMatch = url.pathname.match(/^\/api\/work\/turns\/stream\/([^/]+)$/);
    const isStream = streamMatch !== null && request.method === "GET";
    if (!isAttachment && !isStart && !isCancel && !isLookup && !isTranscript && !isStream)
      return undefined;

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        throw new WorkTurnRouteRejected("Work turn requests cannot supply window identity.", 400);
      }
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { category: "unauthorized", message: "Work turn request is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        { category: "invalid", message: "Work turn request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isAttachment) {
        return await handleAttachment(request, url, authenticatedWindowId, origin);
      }
      if (isLookup) {
        if (url.search !== "") {
          throw new WorkTurnRouteRejected("Work turn request is invalid.", 400);
        }
        const requestId = decodeWorkTurnRequestId(decodeURIComponent(lookupMatch![1]!));
        return jsonResponse(
          decodeWorkTurnLookupResult(
            await dependencies.service.lookupFirstTurn(authenticatedWindowId, requestId),
          ),
          200,
          origin,
        );
      }
      if (isTranscript) {
        if (url.search !== "") {
          throw new WorkTurnRouteRejected("Work turn request is invalid.", 400);
        }
        const threadId = decodeWorkThreadId(decodeURIComponent(transcriptMatch![1]!));
        return jsonResponse(
          decodeWorkThreadTranscript(
            await dependencies.service.transcript(authenticatedWindowId, threadId),
          ),
          200,
          origin,
        );
      }
      if (isStream) {
        const encodedThreadId = streamMatch?.[1];
        if (encodedThreadId === undefined) {
          throw new WorkTurnRouteRejected("Work turn stream path is invalid.", 400);
        }
        const threadId = decodeWorkThreadId(decodeURIComponent(encodedThreadId));
        const afterSequence = Number(url.searchParams.get("afterSequence"));
        if (
          !url.searchParams.has("afterSequence") ||
          url.searchParams.size !== 1 ||
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0
        ) {
          throw new WorkTurnRouteRejected("Work turn stream cursor is invalid.", 400);
        }
        return workTurnStreamResponse(
          dependencies.service.subscribe(
            authenticatedWindowId,
            threadId,
            afterSequence,
            request.signal,
          ),
          request.signal,
          origin,
        );
      }
      if (url.search !== "") {
        throw new WorkTurnRouteRejected("Work turn request is invalid.", 400);
      }
      requireJsonContentType(request);
      const body = await readBoundedBytes(request, jsonLimit);
      const value = parseJson(body);
      if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
        throw new WorkTurnRouteRejected("Work turn requests cannot supply window identity.", 400);
      }
      if (isCancel) {
        return jsonResponse(
          decodeWorkTurnCancelResult(
            await dependencies.service.cancelFirstTurn(authenticatedWindowId, value),
          ),
          200,
          origin,
        );
      }
      return jsonResponse(
        decodeWorkTurnLookupResult(
          await dependencies.service.startFirstTurn(authenticatedWindowId, value),
        ),
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof WorkTurnRouteRejected) {
        return failureResponse(
          {
            category:
              error.status === 409 ? "stale" : error.status === 503 ? "unavailable" : "invalid",
            message: error.message,
          },
          error.status,
          origin,
        );
      }
      if (error instanceof WorkTurnServiceError) {
        return failureResponse(error.failure, statusFor(error.failure.category), origin);
      }
      return failureResponse(
        { category: "unavailable", message: "Octant Work turn service is unavailable." },
        503,
        origin,
      );
    }
  };
}

function workTurnStreamResponse(
  frames: AsyncIterable<WorkTurnStreamFrame>,
  signal: AbortSignal,
  origin: string | null,
): Response {
  const encoder = new TextEncoder();
  const iterator = frames[Symbol.asyncIterator]();
  const abort = (): void => {
    void iterator.return?.(undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) {
          controller.close();
          return;
        }
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`${JSON.stringify(decodeWorkTurnStreamFrame(next.value))}\n`),
        );
      } catch {
        controller.close();
      }
    },
    async cancel() {
      signal.removeEventListener("abort", abort);
      await iterator.return?.(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

class WorkTurnRouteRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkTurnRouteRejected";
  }
}

function statusFor(category: WorkTurnFailure["category"]): number {
  switch (category) {
    case "unauthorized":
      return 401;
    case "stale":
      return 409;
    case "unavailable":
      return 503;
    case "unsupported":
      return 422;
    default:
      return 400;
  }
}

function failureResponse(
  failure: WorkTurnFailure,
  status: number,
  origin: string | null,
): Response {
  return jsonResponse(decodeWorkTurnFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
  };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function requireJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("application/json")) {
    throw new WorkTurnRouteRejected("Work turn request must be application/json.", 400);
  }
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > limit) {
    throw new WorkTurnRouteRejected("Work turn request body is too large.", 400);
  }
  return buffer;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new WorkTurnRouteRejected("Work turn request body is invalid JSON.", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAttachmentUpload(request: Request): {
  readonly threadId: WorkThreadId;
  readonly attachmentId: WorkAttachmentId;
  readonly displayName: string;
  readonly mediaType: WorkAttachmentMediaType;
} {
  const threadHeader = request.headers.get("x-octant-work-thread-id");
  const attachmentHeader = request.headers.get("x-octant-work-attachment-id");
  const encodedDisplayName = request.headers.get("x-octant-work-display-name");
  if (threadHeader === null || threadHeader.trim() === "") {
    throw new WorkTurnRouteRejected("Work attachment requires a thread identity.", 400);
  }
  if (attachmentHeader === null || attachmentHeader.trim() === "") {
    throw new WorkTurnRouteRejected("Work attachment requires an attachment identity.", 400);
  }
  if (encodedDisplayName === null || encodedDisplayName.trim() === "") {
    throw new WorkTurnRouteRejected("Work attachment requires a display name.", 400);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  let displayName: string;
  try {
    displayName = decodeURIComponent(encodedDisplayName);
  } catch {
    throw new WorkTurnRouteRejected("Work attachment display name is invalid.", 400);
  }
  try {
    return {
      threadId: decodeWorkThreadId(threadHeader),
      attachmentId: decodeWorkAttachmentId(attachmentHeader),
      displayName,
      mediaType: decodeWorkAttachmentMediaType(mediaType),
    };
  } catch {
    throw new WorkTurnRouteRejected("Work attachment metadata is invalid.", 400);
  }
}

function readAttachmentTarget(url: URL): {
  readonly threadId: WorkThreadId;
  readonly attachmentId: WorkAttachmentId;
} {
  try {
    return {
      threadId: decodeWorkThreadId(url.searchParams.get("thread") ?? ""),
      attachmentId: decodeWorkAttachmentId(url.searchParams.get("attachment") ?? ""),
    };
  } catch {
    throw new WorkTurnRouteRejected("Work attachment reference is invalid.", 400);
  }
}
