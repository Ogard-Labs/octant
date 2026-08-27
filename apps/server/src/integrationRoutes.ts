import {
  decodeIntegrationAuthenticationCommand,
  type IntegrationAuthenticationCommand,
} from "@octant/contracts/integration";
import type { IntegrationService } from "./integration/integrationService";
import { resolvePrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const BODY_LIMIT = 16 * 1024;
const SECRET_BODY_LIMIT = 12 * 1_024;
const AUTH_PREFIX = "/api/integrations/";
const CALLBACK_PREFIX = "/oauth/integrations/";

export function createIntegrationRouteHandler(dependencies: {
  readonly service: IntegrationService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const callback = matchCallback(url.pathname);
    if (callback !== undefined) {
      return handleCallback(request, url, callback.slug, dependencies.service);
    }
    const api = matchApi(url.pathname);
    if (api === undefined) return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return failure("invalid", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (url.search !== "") return failure("invalid", 400, origin);
    const snapshotRoute = api.rest === "authentication";
    const commandRoute = api.rest === "authentication/commands";
    const secretRoute = api.rest === "secrets";
    if (snapshotRoute && request.method !== "GET" && request.method !== "HEAD") {
      return failure("invalid", 400, origin);
    }
    if ((commandRoute || secretRoute) && request.method !== "POST") {
      return failure("invalid", 400, origin);
    }
    if (!snapshotRoute && !commandRoute && !secretRoute) return failure("invalid", 400, origin);

    let body: unknown = undefined;
    if (!snapshotRoute) {
      const parsed = await readJson(request, secretRoute ? SECRET_BODY_LIMIT : BODY_LIMIT);
      if (parsed.kind !== "ok") {
        return failure("invalid", parsed.kind === "too-large" ? 413 : 400, origin);
      }
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
    if (context.principal.kind !== "local-window" && context.principal.kind !== "remote-device") {
      return failure("unauthorized", 403, origin);
    }
    try {
      if (snapshotRoute) {
        return response(await dependencies.service.snapshot(api.slug, request.signal), 200, origin);
      }
      if (commandRoute) {
        let command: IntegrationAuthenticationCommand;
        try {
          command = decodeIntegrationAuthenticationCommand(body);
        } catch {
          return failure("invalid", 400, origin);
        }
        return response(
          await dependencies.service.execute(api.slug, command, request.signal),
          200,
          origin,
        );
      }
      const secret = decodeSecretCommand(body);
      if (secret === undefined) return failure("invalid", 400, origin);
      if (secret.kind === "put") {
        const stored = await dependencies.service.putSecret(
          api.slug,
          "personal-api-key",
          secret.credential,
        );
        if (stored.kind !== "stored") return failure("unavailable", 503, origin);
        return response({ kind: "stored" }, 200, origin);
      }
      await dependencies.service.deleteSecret(api.slug, "personal-api-key");
      return response({ kind: "cleared" }, 200, origin);
    } catch {
      return failure("unavailable", 503, origin);
    }
  };
}

async function handleCallback(
  request: Request,
  url: URL,
  slug: string,
  service: IntegrationService,
): Promise<Response> {
  if (!isLoopbackHostname(url.hostname) || request.method !== "GET") {
    return htmlCallback("Linear connection failed.", 400);
  }
  const error = url.searchParams.get("error");
  if (error !== null) return htmlCallback("Linear connection was cancelled.", 200);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null || code.length === 0 || state.length === 0) {
    return htmlCallback("Linear connection failed.", 400);
  }
  const completed = await service.completeAuthorization(slug, { code, state });
  if (completed.kind !== "stored") {
    return htmlCallback("Linear connection failed.", 400);
  }
  return htmlCallback("Linear is connected. You can close this window and return to Octant.", 200);
}

function matchApi(pathname: string): { readonly slug: string; readonly rest: string } | undefined {
  if (!pathname.startsWith(AUTH_PREFIX)) return undefined;
  const rest = pathname.slice(AUTH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const slug = rest.slice(0, slash);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug)) return undefined;
  return { slug, rest: rest.slice(slash + 1) };
}

function matchCallback(pathname: string): { readonly slug: string } | undefined {
  if (!pathname.startsWith(CALLBACK_PREFIX)) return undefined;
  const rest = pathname.slice(CALLBACK_PREFIX.length);
  const match = /^([a-z][a-z0-9-]{0,31})\/callback$/.exec(rest);
  if (match === null || match[1] === undefined) return undefined;
  return { slug: match[1] };
}

function decodeSecretCommand(
  body: unknown,
): { readonly kind: "put"; readonly credential: string } | { readonly kind: "delete" } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!("kind" in body) || !("scope" in body) || body.scope !== "personal-api-key") {
    return undefined;
  }
  const keys = Object.keys(body);
  if (body.kind === "delete" && keys.length === 2) return { kind: "delete" };
  if (
    body.kind === "put" &&
    "credential" in body &&
    typeof body.credential === "string" &&
    body.credential.length > 0 &&
    Buffer.byteLength(body.credential, "utf8") <= SECRET_BODY_LIMIT &&
    keys.length === 3
  ) {
    return { kind: "put", credential: body.credential };
  }
  return undefined;
}

async function readJson(
  request: Request,
  limit: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" | "too-large" }> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > limit) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function htmlCallback(message: string, status: number): Response {
  const safe = message.replace(/[<>&]/g, "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Octant</title></head><body><p>${safe}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
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
          ? "Integration request is unauthorized."
          : category === "unavailable"
            ? "The integration is unavailable."
            : "Integration request is invalid.",
    },
    status,
    origin,
  );
}

function cors(origin: string | null): HeadersInit {
  return {
    "access-control-allow-origin": origin ?? "http://127.0.0.1",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    "cache-control": "no-store",
  };
}
