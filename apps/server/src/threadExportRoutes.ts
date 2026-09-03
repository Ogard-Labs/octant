import {
  decodeThreadExportOutcome,
  type ThreadExportOutcome,
} from "@octant/contracts/thread-export";
import {
  decodeThreadHandOffOutcome,
  type ThreadHandOffOutcome,
} from "@octant/contracts/thread-hand-off";
import type { ThreadExportActorKind } from "@octant/domain";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ThreadExportService } from "./threadExportService";
import type { ThreadHandOffService } from "./threadHandOffService";

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 8_192;

/**
 * The HTTP entries for the authenticated thread export and hand-off commands.
 *
 * Loopback and an allow-listed renderer origin, then a principal the
 * transport already proved — a local window capability, or a paired device
 * the gateway bound. The service re-checks that the caller may Open the
 * named thread before it cuts the bundle; hand-off starts from that same cut.
 */

export interface ThreadExportRouteDependencies {
  readonly service: ThreadExportService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export interface ThreadHandOffRouteDependencies {
  readonly service: ThreadHandOffService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createThreadExportRouteHandler(dependencies: ThreadExportRouteDependencies) {
  return createThreadCommandRouteHandler({
    path: "/api/threads/export",
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    execute: (windowId, actorKind, body) =>
      dependencies.service.exportThread(windowId, actorKind, body),
    status: (outcome: ThreadExportOutcome) =>
      outcome.kind === "exported" ? 200 : outcome.reason === "unauthorized" ? 401 : 404,
    encode: decodeThreadExportOutcome,
  });
}

export function createThreadHandOffRouteHandler(dependencies: ThreadHandOffRouteDependencies) {
  return createThreadCommandRouteHandler({
    path: "/api/threads/hand-off",
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    execute: (windowId, actorKind, body) => dependencies.service.handOff(windowId, actorKind, body),
    // A refusal the person can act on is an ordinary answer, not an HTTP failure.
    status: (outcome: ThreadHandOffOutcome) =>
      outcome.kind === "handed-off"
        ? 200
        : outcome.reason === "unauthorized"
          ? 401
          : outcome.reason === "not-found"
            ? 404
            : 200,
    encode: decodeThreadHandOffOutcome,
  });
}

function createThreadCommandRouteHandler<Outcome>(options: {
  readonly path: string;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly execute: (
    windowId: ReturnType<typeof authenticateRouteWindowId>,
    actorKind: ThreadExportActorKind,
    body: unknown,
  ) => Promise<Outcome>;
  readonly status: (outcome: Outcome) => number;
  readonly encode: (outcome: Outcome) => unknown;
}) {
  const now = options.now ?? Date.now;
  const dependencies = { windowAuthorityStore: options.windowAuthorityStore };
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== options.path) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Thread export requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failureResponse("Thread export requires POST.", 405, origin);
    }

    let windowId;
    let actorKind: ThreadExportActorKind = "local-window";
    try {
      const bound = readPrincipalRouteContext(request);
      if (bound === undefined) {
        windowId = authenticateRouteWindowId({
          request,
          store: dependencies.windowAuthorityStore,
          now: now(),
        });
      } else {
        windowId = bound.scopeId;
        actorKind = bound.principal.kind === "remote-device" ? "remote-device" : "local-window";
      }
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Thread export is unauthorized.", 401, origin);
      }
      return failureResponse("Thread export request is invalid.", 400, origin);
    }

    const decoded = await readJson(request, BODY_LIMIT);
    if (decoded.kind === "too-large") {
      return failureResponse("Request body is too large.", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return failureResponse("Request body must be valid JSON.", 400, origin);
    }

    const outcome = await options.execute(windowId, actorKind, decoded.value);
    return jsonResponse(options.encode(outcome), options.status(outcome), origin);
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ error: message }, status, origin);
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readJson(request: Request, limit: number): Promise<ReadJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    return { kind: "too-large" };
  }
  try {
    const text = await request.text();
    if (text.length > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}
