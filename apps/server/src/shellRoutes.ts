import { decodeShellCommand, decodeWindowId, type ShellFailure } from "@octant/contracts";
import { ShellServiceError, type ShellServiceApi } from "./shellService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type";

export function createShellRouteHandler(service: ShellServiceApi) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isShellRoute =
      url.pathname === "/api/shell/bootstrap" || url.pathname === "/api/shell/commands";
    if (!isShellRoute) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "unsupported", message: "Shell API requests must use loopback." },
        origin,
      );
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failureResponse(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        null,
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === "/api/shell/bootstrap") {
        if (request.method !== "GET") return unsupportedMethod(origin);
        let windowId;
        try {
          windowId = decodeWindowId(url.searchParams.get("windowId"));
        } catch {
          return failureResponse(
            { category: "invalid", message: "A valid windowId is required." },
            origin,
          );
        }
        return jsonResponse(service.bootstrap(windowId), 200, origin);
      }

      if (request.method !== "POST") return unsupportedMethod(origin);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failureResponse(
          { category: "invalid", message: "Command body must be valid JSON." },
          origin,
        );
      }
      let command;
      try {
        command = decodeShellCommand(body);
      } catch {
        return failureResponse(
          { category: "invalid", message: "Shell command is invalid." },
          origin,
        );
      }
      return jsonResponse(service.execute(command), 200, origin);
    } catch (error) {
      if (error instanceof ShellServiceError) {
        return failureResponse(error.failure, origin);
      }
      return failureResponse(
        { category: "unavailable", message: "Octant shell service is unavailable." },
        origin,
      );
    }
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function isAllowedRendererOrigin(origin: string): boolean {
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

function unsupportedMethod(origin: string | null): Response {
  return failureResponse(
    { category: "unsupported", message: "HTTP method is not supported for this route." },
    origin,
  );
}

function failureResponse(failure: ShellFailure, origin: string | null): Response {
  const status =
    failure.category === "conflict"
      ? 409
      : failure.category === "unavailable" || failure.category === "recovery-required"
        ? 503
        : 400;
  return jsonResponse(failure, status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
