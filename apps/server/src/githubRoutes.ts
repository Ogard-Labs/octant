import {
  decodeGithubAuthenticationCommand,
  decodeGithubCatalogueReadRequest,
  decodeGithubRecentRepositoryCommand,
  type GithubAuthenticationCommand,
  type GithubCatalogueReadRequest,
  type GithubCatalogueReadResponse,
  type GithubRecentRepositoryCommand,
} from "@octant/contracts";
import type { GithubCapabilityService } from "./github/githubCapabilityService";
import { resolvePrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const BODY_LIMIT = 16 * 1024;
const ROUTES = new Set([
  "/api/github/authentication",
  "/api/github/authentication/commands",
  "/api/github/catalogue/reads",
  "/api/github/catalogue/recents",
]);

interface GithubCatalogueRoutePort {
  read(
    request: GithubCatalogueReadRequest,
    signal: AbortSignal,
  ): Promise<GithubCatalogueReadResponse>;
  recordRecentRepository(
    command: GithubRecentRepositoryCommand,
    signal: AbortSignal,
  ): Promise<GithubCatalogueReadResponse>;
}

export function createGithubRouteHandler(dependencies: {
  readonly service: GithubCapabilityService;
  readonly catalogue: GithubCatalogueRoutePort;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  /** Gates every route in this file on the @octant/github first-party plugin (ADR 0001). Absent means always effective. */
  readonly githubPluginEffective?: () => boolean;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!ROUTES.has(url.pathname)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin)))
      return failure("invalid", 400, origin);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });
    if (dependencies.githubPluginEffective?.() === false)
      return failure("unavailable", 503, origin);
    const snapshotRoute = url.pathname === "/api/github/authentication";
    if (
      (snapshotRoute && request.method !== "GET" && request.method !== "HEAD") ||
      (!snapshotRoute && request.method !== "POST") ||
      url.search !== ""
    )
      return failure("invalid", 400, origin);
    let body: unknown = undefined;
    if (!snapshotRoute) {
      const parsed = await readJson(request);
      if (parsed.kind !== "ok")
        return failure("invalid", parsed.kind === "too-large" ? 413 : 400, origin);
      body = parsed.value;
    }
    let context;
    try {
      context = resolvePrincipalRouteContext({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch {
      return failure("unauthorized", 401, origin);
    }
    // A paired client reaches the exact owning host through its authenticated
    // remote-device principal. Providers, agents, automations, and extensions
    // remain excluded: their only GitHub surface is the server-authorized
    // app-managed read tools, never these user routes.
    if (context.principal.kind !== "local-window" && context.principal.kind !== "remote-device")
      return failure("unauthorized", 403, origin);
    try {
      switch (url.pathname) {
        case "/api/github/authentication":
          return response(await dependencies.service.snapshot(request.signal), 200, origin);
        case "/api/github/authentication/commands": {
          let command: GithubAuthenticationCommand;
          try {
            command = decodeGithubAuthenticationCommand(body);
          } catch {
            return failure("invalid", 400, origin);
          }
          return response(await dependencies.service.execute(command, request.signal), 200, origin);
        }
        case "/api/github/catalogue/reads": {
          let read: GithubCatalogueReadRequest;
          try {
            read = decodeGithubCatalogueReadRequest(body);
          } catch {
            return failure("invalid", 400, origin);
          }
          return response(await dependencies.catalogue.read(read, request.signal), 200, origin);
        }
        default: {
          let command: GithubRecentRepositoryCommand;
          try {
            command = decodeGithubRecentRepositoryCommand(body);
          } catch {
            return failure("invalid", 400, origin);
          }
          return response(
            await dependencies.catalogue.recordRecentRepository(command, request.signal),
            200,
            origin,
          );
        }
      }
    } catch {
      return failure("unavailable", 503, origin);
    }
  };
}

async function readJson(
  request: Request,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" | "too-large" }> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}
function response(body: unknown, status: number, origin: string | null) {
  return Response.json(body, { status, headers: cors(origin) });
}
function failure(
  category: "invalid" | "unauthorized" | "unavailable",
  status: number,
  origin: string | null,
) {
  return response(
    {
      category,
      message:
        category === "unauthorized"
          ? "GitHub request is unauthorized."
          : category === "unavailable"
            ? "GitHub is unavailable."
            : "GitHub request is invalid.",
    },
    status,
    origin,
  );
}
function cors(origin: string | null) {
  return {
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    vary: "Origin",
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
  };
}
