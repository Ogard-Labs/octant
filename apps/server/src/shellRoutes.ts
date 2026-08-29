import { decodeShellCommand, type ShellFailure } from "@octant/contracts";
import { WINDOW_CAPABILITY_HEADER } from "./clientPrincipal";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { ShellServiceError, type ShellServiceApi } from "./shellService";
import { isCanonical256BitToken, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
export const SHELL_RENDERER_IDENTITY_HEADER = "x-octant-renderer-identity";
const HEADERS = `content-type, x-octant-window-capability, ${SHELL_RENDERER_IDENTITY_HEADER}`;

export interface ShellRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  /**
   * HTTP origin the renderer is allowed to present. `null` is packaged
   * (`file://` only). Omitted keeps loopback-any-port for tests.
   */
  readonly allowedRendererHttpOrigin?: string | null;
}

export function createShellRouteHandler(
  service: ShellServiceApi,
  dependencies: ShellRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const allowedHttpOrigin = dependencies.allowedRendererHttpOrigin;
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
    const opaqueOrigin = origin === "file://" || origin === "null";
    if (origin !== null) {
      if (opaqueOrigin) {
        if (typeof allowedHttpOrigin === "string") {
          return failureResponse(
            { category: "unsupported", message: "Renderer origin is not allowed." },
            null,
          );
        }
      } else if (!isAllowedRendererOrigin(origin, allowedHttpOrigin)) {
        return failureResponse(
          { category: "unsupported", message: "Renderer origin is not allowed." },
          null,
        );
      }
    }

    if (request.method === "OPTIONS") {
      if (origin === null) {
        return failureResponse(
          { category: "unsupported", message: "Renderer origin is required." },
          null,
        );
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // Electron's packaged renderer may report an opaque file origin or no
      // Origin at all. Neither form is trusted by itself: both the capability
      // and the server-bound renderer identity must resolve to this window.
      const requiresRendererIdentity = origin === null || opaqueOrigin;
      const rendererIdentity = request.headers.get(SHELL_RENDERER_IDENTITY_HEADER) ?? "";
      if (
        requiresRendererIdentity &&
        (!request.headers.has(WINDOW_CAPABILITY_HEADER) ||
          !isCanonical256BitToken(rendererIdentity))
      ) {
        return failureResponse(
          { category: "unsupported", message: "Packaged renderer identity is required." },
          null,
        );
      }
      if (url.search !== "") {
        return failureResponse(
          { category: "invalid", message: "Shell requests cannot supply window identity." },
          origin,
        );
      }
      let windowId;
      try {
        windowId = requiresRendererIdentity
          ? dependencies.windowAuthorityStore.authenticateRenderer(
              request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "",
              rendererIdentity,
              now(),
            )
          : authenticateRouteWindowId({
              request,
              store: dependencies.windowAuthorityStore,
              now: now(),
            });
      } catch {
        return failureResponse(
          { category: "invalid", message: "Shell request is unauthorized." },
          origin,
          401,
        );
      }

      if (url.pathname === "/api/shell/bootstrap") {
        if (request.method !== "GET" && request.method !== "POST") {
          return unsupportedMethod(origin);
        }
        if (request.method === "POST") {
          if (await hasUnexpectedBody(request)) {
            return failureResponse(
              {
                category: "invalid",
                message: "Shell bootstrap registration must not supply a body.",
              },
              origin,
            );
          }
          return jsonResponse(service.bootstrap(windowId), 200, origin);
        }
        const bootstrap = service.readBootstrap(windowId);
        if (bootstrap === undefined) {
          return failureResponse(
            { category: "invalid", message: "Shell bootstrap window is not registered." },
            origin,
          );
        }
        return jsonResponse(bootstrap, 200, origin);
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
      if (String(command.windowId) !== String(windowId)) {
        return failureResponse(
          { category: "invalid", message: "Shell command window does not match its capability." },
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

/**
 * Packaged renderers present `file://`. Development may pin the Vite origin.
 * Tests omit `allowedHttpOrigin` and keep loopback HTTP on any port.
 */
export function isAllowedRendererOrigin(
  origin: string,
  allowedHttpOrigin?: string | null,
): boolean {
  if (allowedHttpOrigin === null) return origin === "file://";
  if (origin === "file://") return allowedHttpOrigin === undefined;
  try {
    const url = new URL(origin);
    const loopbackHttp =
      origin === url.origin &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    if (!loopbackHttp) return false;
    if (allowedHttpOrigin === undefined) return true;
    return origin === allowedHttpOrigin;
  } catch {
    return false;
  }
}

export function resolveAllowedRendererHttpOrigin(input: {
  readonly packaged?: boolean;
  readonly developmentWebUrl?: string;
}): string | null | undefined {
  if (input.packaged === true) return null;
  const developmentWebUrl = input.developmentWebUrl;
  if (developmentWebUrl === undefined || developmentWebUrl === "") return undefined;
  try {
    const url = new URL(developmentWebUrl);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function unsupportedMethod(origin: string | null): Response {
  return failureResponse(
    { category: "unsupported", message: "HTTP method is not supported for this route." },
    origin,
  );
}

function failureResponse(
  failure: ShellFailure,
  origin: string | null,
  explicitStatus?: number,
): Response {
  const status =
    explicitStatus ??
    (failure.category === "conflict"
      ? 409
      : failure.category === "unavailable" || failure.category === "recovery-required"
        ? 503
        : 400);
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
  if (origin === "null") {
    headers.set("access-control-allow-origin", origin);
  } else if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

async function hasUnexpectedBody(request: Request): Promise<boolean> {
  if (request.body === null) return false;
  return (await request.text()).length > 0;
}
