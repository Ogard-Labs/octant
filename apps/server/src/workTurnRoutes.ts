import {
  WorkTurnFailure as WorkTurnFailureSchema,
  decodeWorkThreadId,
  decodeWorkThreadTranscript,
  decodeWorkTurnCancelResult,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnFailure,
  type WorkTurnLookupResult,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { WorkTurnServiceError } from "./work/workTurnService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
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
}

export interface WorkTurnRouteDependencies {
  readonly service: WorkTurnRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createWorkTurnRouteHandler(dependencies: WorkTurnRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/work/turns")) return undefined;
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

    const isStart = url.pathname === "/api/work/turns" && request.method === "POST";
    const isCancel = url.pathname === "/api/work/turns/cancel" && request.method === "POST";
    const lookupMatch = url.pathname.match(/^\/api\/work\/turns\/([^/]+)$/);
    const isLookup = lookupMatch !== null && request.method === "GET";
    const transcriptMatch = url.pathname.match(/^\/api\/work\/turns\/transcript\/([^/]+)$/);
    const isTranscript = transcriptMatch !== null && request.method === "GET";
    if (!isStart && !isCancel && !isLookup && !isTranscript) return undefined;

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
