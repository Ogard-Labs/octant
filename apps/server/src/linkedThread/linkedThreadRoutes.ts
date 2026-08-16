import {
  decodeLinkedThreadPreviewCommand,
  decodeLinkedThreadPreviewCommandResult,
  decodeLinkedThreadPreviewFailure,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { authenticateProjectRequest } from "../projectBindingRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { LinkedThreadService } from "./linkedThreadService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface LinkedThreadRouteDependencies {
  readonly service: LinkedThreadService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createLinkedThreadRouteHandler(dependencies: LinkedThreadRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/linked-threads/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { code: "unsupported", message: "Linked-thread API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { code: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    if (url.pathname !== "/api/linked-threads/commands" || request.method !== "POST")
      return undefined;

    let body: unknown;
    let authenticatedWindowId;
    try {
      body = await readJsonBody(request, jsonLimit);
      authenticatedWindowId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { code: "unauthorized", message: "Linked-thread command is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        { code: "invalid", message: "Linked-thread command is invalid." },
        400,
        origin,
      );
    }

    try {
      const command = decodeLinkedThreadPreviewCommand(body);
      const result = await dependencies.service.execute(authenticatedWindowId, command);
      if ("code" in result)
        return failureResponse(decodeLinkedThreadPreviewFailure(result), 400, origin);
      return jsonResponse(decodeLinkedThreadPreviewCommandResult(result), 200, origin);
    } catch {
      return failureResponse(
        { code: "invalid", message: "Linked-thread command is invalid." },
        400,
        origin,
      );
    }
  };
}

async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > limit)
    throw new Error("Request body is too large.");
  return JSON.parse(await request.text()) as unknown;
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failureResponse(body: unknown, status: number, origin: string | null): Response {
  return jsonResponse(body, status, origin);
}
