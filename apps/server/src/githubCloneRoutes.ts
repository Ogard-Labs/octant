import {
  decodeGithubCloneCommand,
  type GithubCloneCommand,
  type GithubCloneCommandResponse,
  type GithubCloneOperationList,
  type WindowId,
} from "@octant/contracts";
import { resolvePrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const BODY_LIMIT = 16 * 1024;
const COMMANDS_ROUTE = "/api/github/clone/commands";
const OPERATIONS_ROUTE = "/api/github/clone/operations";

interface GithubCloneRoutePort {
  execute(
    command: GithubCloneCommand,
    context: { readonly windowId: WindowId },
    signal: AbortSignal,
  ): Promise<GithubCloneCommandResponse>;
  list(): GithubCloneOperationList;
}

export function createGithubCloneRouteHandler(dependencies: {
  readonly service: GithubCloneRoutePort;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_ROUTE && url.pathname !== OPERATIONS_ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin)))
      return failure("invalid", 400, origin);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });
    const operationsRoute = url.pathname === OPERATIONS_ROUTE;
    if (
      (operationsRoute && request.method !== "GET" && request.method !== "HEAD") ||
      (!operationsRoute && request.method !== "POST") ||
      url.search !== ""
    )
      return failure("invalid", 400, origin);
    let body: unknown = undefined;
    if (!operationsRoute) {
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
    // Only the host user (locally or through an authenticated paired device)
    // may request, confirm, cancel, or attach a managed clone. Providers,
    // agents, automations, and extensions have no clone surface at all.
    if (context.principal.kind !== "local-window" && context.principal.kind !== "remote-device")
      return failure("unauthorized", 403, origin);
    try {
      if (operationsRoute) return response(dependencies.service.list(), 200, origin);
      let command: GithubCloneCommand;
      try {
        command = decodeGithubCloneCommand(body);
      } catch {
        return failure("invalid", 400, origin);
      }
      return response(
        await dependencies.service.execute(command, { windowId: context.scopeId }, request.signal),
        200,
        origin,
      );
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
          ? "GitHub clone request is unauthorized."
          : category === "unavailable"
            ? "GitHub clone is unavailable."
            : "GitHub clone request is invalid.",
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
