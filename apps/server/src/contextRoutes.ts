import {
  decodeContextCommand,
  decodeContextInspectorRequest,
  type ContextCommand,
  type ContextCommandResult,
  type ContextInspectorSnapshot,
  type ContextSubjectRef,
} from "@octant/contracts";
import { ContextHarnessError } from "./context/contextHarnessService";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ContextRouteService {
  readonly inspect: (
    subject: ContextSubjectRef,
    afterSequence?: number,
  ) => ContextInspectorSnapshot;
  readonly execute: (command: ContextCommand) => ContextCommandResult;
}

export interface ContextRouteDependencies {
  readonly service: ContextRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createContextRouteHandler(dependencies: ContextRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isInspect = url.pathname === "/api/context/inspect";
    const isCommand = url.pathname === "/api/context/commands";
    if (!isInspect && !isCommand) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("invalid", "Context API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("invalid", "Renderer origin is not allowed.", 400, null);
    }
    if (url.search !== "") {
      return failure("invalid", "Context request is invalid.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure("invalid", "HTTP method is not supported for this route.", 400, origin);
    }

    const decoded = await readJson(request, bodyLimit);
    if (decoded.kind === "too-large") {
      return failure("invalid", "Request body is too large.", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return failure("invalid", "Request body must be valid JSON.", 400, origin);
    }
    try {
      authenticateProjectRequest({
        request,
        body: decoded.value,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("unauthorized", "Context request is unauthorized.", 401, origin);
      }
      return failure("invalid", "Context request is invalid.", 400, origin);
    }

    try {
      if (isInspect) {
        const input = decodeContextInspectorRequest(decoded.value);
        return response(
          dependencies.service.inspect(input.subject, input.afterSequence),
          200,
          origin,
        );
      }
      const command = decodeContextCommand(decoded.value);
      return response(dependencies.service.execute(command), 200, origin);
    } catch (error) {
      if (error instanceof ContextHarnessError) return harnessFailure(error, origin);
      if (isDecodeError(error)) {
        return failure("invalid", "Context request is invalid.", 400, origin);
      }
      return failure("unavailable", "Octant Context service is unavailable.", 503, origin);
    }
  };
}

function harnessFailure(error: ContextHarnessError, origin: string | null): Response {
  switch (error.category) {
    case "stale":
      return failure("stale", "Reload context before retrying.", 409, origin);
    case "blocked":
      return failure("blocked", "Context update is blocked by the safe budget.", 409, origin);
    case "invalid":
      return failure("invalid", "Context request is invalid.", 400, origin);
    case "unavailable":
      return failure("unavailable", "Octant Context service is unavailable.", 503, origin);
  }
}

async function readJson(
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

function isDecodeError(error: unknown): boolean {
  return error instanceof Error && error.name === "ParseError";
}

function response(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(
  category: "unauthorized" | "stale" | "invalid" | "unavailable" | "blocked",
  message: string,
  status: number,
  origin: string | null,
): Response {
  return response({ category, message }, status, origin);
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
