import {
  decodeCompatibleProjectLookupRequest,
  decodeCompatibleProjectLookupResult,
  decodeCreateRootlessThreadCommand,
  decodeCancelRootlessTurnCommand,
  decodeRootlessThreadCreateResult,
  decodeRootlessThreadListResult,
  decodeRootlessTurnCancelResult,
  decodeRootlessTurnLookupResult,
  decodeStartRootlessThreadTurnCommand,
  type AttachFolderFailure,
} from "@octant/contracts";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import type { RootlessThreadServiceApi } from "./rootlessThreadService";
import { RootlessThreadServiceError } from "./rootlessThreadService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface RootlessThreadRouteDependencies {
  readonly service: RootlessThreadServiceApi;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createRootlessThreadRouteHandler(dependencies: RootlessThreadRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/rootless/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return response(
        { category: "unsupported", message: "Rootless thread API requests must use loopback." },
        400,
        null,
      );
    if (origin !== null && !isAllowedOrigin(origin))
      return response(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const isThreadList = url.pathname === "/api/rootless/threads" && request.method === "GET";
    const isThreadCreate = url.pathname === "/api/rootless/threads" && request.method === "POST";
    const isTurnStart = url.pathname === "/api/rootless/turns" && request.method === "POST";
    const isTurnCancel = url.pathname === "/api/rootless/turns/cancel" && request.method === "POST";
    const turnLookupMatch = url.pathname.match(/^\/api\/rootless\/turns\/([^/]+)$/);
    const isTurnLookup = turnLookupMatch !== null && request.method === "GET";
    const isCompatibleProjects = url.pathname === "/api/rootless/compatible-projects";
    const isAttachFolder = url.pathname === "/api/rootless/attach-folder";
    if (
      !isThreadList &&
      !isThreadCreate &&
      !isTurnStart &&
      !isTurnCancel &&
      !isTurnLookup &&
      !isCompatibleProjects &&
      !isAttachFolder
    )
      return undefined;

    if (isThreadList) {
      if (request.method !== "GET")
        return response(
          { category: "unsupported", message: "HTTP method is not supported for this route." },
          400,
          origin,
        );
      if (url.search !== "")
        return response(
          { category: "invalid", message: "Rootless thread request is invalid." },
          400,
          origin,
        );
      try {
        authenticateProjectRequest({
          request,
          body: {},
          store: dependencies.windowAuthorityStore,
          now: now(),
        });
        const result = dependencies.service.listThreads();
        return response(decodeRootlessThreadListResult(result), 200, origin);
      } catch (error) {
        if (error instanceof WindowAuthorityError)
          return response(
            { category: "unauthorized", message: "Rootless thread list is unauthorized." },
            401,
            origin,
          );
        return response(
          { category: "unavailable", message: "Octant rootless thread service is unavailable." },
          503,
          origin,
        );
      }
    }

    if (isTurnLookup) {
      if (url.search !== "")
        return response(
          { category: "invalid", message: "Rootless turn lookup request is invalid." },
          400,
          origin,
        );
      try {
        authenticateProjectRequest({
          request,
          body: {},
          store: dependencies.windowAuthorityStore,
          now: now(),
        });
        const requestId = decodeURIComponent(turnLookupMatch[1]!);
        return response(
          decodeRootlessTurnLookupResult(dependencies.service.lookupFirstTurn(requestId)),
          200,
          origin,
        );
      } catch (error) {
        if (error instanceof WindowAuthorityError)
          return response(
            { category: "unauthorized", message: "Rootless turn lookup is unauthorized." },
            401,
            origin,
          );
        if (error instanceof RootlessThreadServiceError)
          return attachFailureResponse(error.category, error.message, origin);
        return response(
          { category: "invalid", message: "Rootless turn lookup request is invalid." },
          400,
          origin,
        );
      }
    }

    if (!isThreadCreate && isCompatibleProjects && request.method !== "POST")
      return response(
        { category: "unsupported", message: "HTTP method is not supported for this route." },
        400,
        origin,
      );
    if (!isThreadCreate && isAttachFolder && request.method !== "POST")
      return response(
        { category: "unsupported", message: "HTTP method is not supported for this route." },
        400,
        origin,
      );
    if (url.search !== "")
      return response(
        { category: "invalid", message: "Rootless thread request is invalid." },
        400,
        origin,
      );

    const read = await readJson(request, bodyLimit);
    if (read.kind === "too-large")
      return response({ category: "invalid", message: "Request body is too large." }, 413, origin);
    if (read.kind === "invalid")
      return response(
        { category: "invalid", message: "Request body must be valid JSON." },
        400,
        origin,
      );

    let windowId;
    try {
      windowId = authenticateProjectRequest({
        request,
        body: read.value,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError)
        return response(
          { category: "unauthorized", message: "Rootless thread request is unauthorized." },
          401,
          origin,
        );
      return response(
        { category: "invalid", message: "Rootless thread request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isThreadCreate) {
        let createCommand;
        try {
          createCommand = decodeCreateRootlessThreadCommand(read.value);
        } catch {
          return response(
            { category: "invalid", message: "Rootless thread creation request is invalid." },
            400,
            origin,
          );
        }
        const result = await dependencies.service.createThread(windowId, createCommand);
        return response(decodeRootlessThreadCreateResult(result), 200, origin);
      }
      if (isTurnStart) {
        let startCommand;
        try {
          startCommand = decodeStartRootlessThreadTurnCommand(read.value);
        } catch {
          return response(
            { category: "invalid", message: "Rootless turn start request is invalid." },
            400,
            origin,
          );
        }
        const result = await dependencies.service.startFirstTurn(windowId, startCommand);
        return response(decodeRootlessTurnLookupResult(result), 202, origin);
      }
      if (isTurnCancel) {
        let cancelCommand;
        try {
          cancelCommand = decodeCancelRootlessTurnCommand(read.value);
        } catch {
          return response(
            { category: "invalid", message: "Rootless turn cancellation request is invalid." },
            400,
            origin,
          );
        }
        const result = await dependencies.service.cancelFirstTurn(cancelCommand);
        return response(decodeRootlessTurnCancelResult(result), 200, origin);
      }
      if (isCompatibleProjects) {
        let lookupRequest;
        try {
          lookupRequest = decodeCompatibleProjectLookupRequest(read.value);
        } catch {
          return response(
            { category: "invalid", message: "Compatible project lookup request is invalid." },
            400,
            origin,
          );
        }
        const entries = await dependencies.service.lookupCompatibleProjects(lookupRequest);
        return response(decodeCompatibleProjectLookupResult({ entries }), 200, origin);
      }
      const result = await dependencies.service.attachFolder(windowId, read.value);
      return response(result, 200, origin);
    } catch (error) {
      if (error instanceof RootlessThreadServiceError) {
        if (error.category === "conflict") {
          return response(
            {
              category: "conflict",
              message: error.message,
              ...(error.conflictReason === undefined ? {} : { reason: error.conflictReason }),
            },
            409,
            origin,
          );
        }
        return attachFailureResponse(error.category, error.message, origin);
      }
      return response(
        { category: "unavailable", message: "Octant rootless thread service is unavailable." },
        503,
        origin,
      );
    }
  };
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

function attachFailureResponse(
  category: AttachFolderFailure["category"],
  message: string,
  origin: string | null,
): Response {
  const status =
    category === "unauthorized"
      ? 401
      : category === "not-found"
        ? 404
        : category === "unavailable"
          ? 503
          : 400;
  return response({ category, message }, status, origin);
}

function response(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname) &&
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
