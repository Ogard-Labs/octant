import { decodeThemeCommand, type ThemeFailure } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { ThemeServiceError, type ThemeServiceApi } from "./themeService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export function createThemeRouteHandler(dependencies: {
  readonly service: ThemeServiceApi;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/theme/bootstrap" && url.pathname !== "/api/theme/commands") {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return failure("unsupported", "Theme API requests must use loopback.", 400, origin);
    if (origin !== null && !isAllowedRendererOrigin(origin))
      return failure("unsupported", "Renderer origin is not allowed.", 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      const category =
        error instanceof WindowAuthorityError && error.category === "invalid"
          ? "invalid"
          : "unauthorized";
      return failure(
        category,
        "Theme request is unauthorized.",
        category === "invalid" ? 400 : 401,
        origin,
      );
    }
    try {
      if (url.pathname === "/api/theme/bootstrap") {
        if (request.method !== "GET")
          return failure(
            "unsupported",
            "HTTP method is not supported for this route.",
            400,
            origin,
          );
        return json(dependencies.service.bootstrap(), 200, origin);
      }
      if (request.method !== "POST")
        return failure("unsupported", "HTTP method is not supported for this route.", 400, origin);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("invalid", "Theme command body must be valid JSON.", 400, origin);
      }
      try {
        decodeThemeCommand(body);
      } catch {
        return failure("invalid", "Theme command is invalid.", 400, origin);
      }
      return json(dependencies.service.execute(body), 200, origin);
    } catch (error) {
      if (error instanceof ThemeServiceError) {
        const status =
          error.failure.category === "conflict"
            ? 409
            : error.failure.category === "unavailable" ||
                error.failure.category === "recovery-required"
              ? 503
              : 400;
        return failure(
          error.failure.category,
          error.failure.message,
          status,
          origin,
          error.failure,
        );
      }
      return failure("unavailable", "Octant theme service is unavailable.", 503, origin);
    }
  };
}

function failure(
  category: string,
  message: string,
  status: number,
  origin: string | null,
  body?: ThemeFailure,
): Response {
  return Response.json(body ?? { category, message }, { status, headers: corsHeaders(origin) });
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}
