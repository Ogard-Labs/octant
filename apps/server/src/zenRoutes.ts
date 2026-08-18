import {
  decodeZenCommand,
  decodeZenFocusZoneCommand,
  decodeZenTerminalAttachRequest,
  decodeZenThreadAttachRequest,
  decodeZenThreadCatalogRef,
  ZenError,
  type ZenCommand,
} from "@octant/contracts/zen";
import type { WindowId } from "@octant/contracts/shell";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ZenService } from "./zen/zenService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

function corsHeaders(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
  return base;
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

export interface ZenRouteDependencies {
  readonly zenService: ZenService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createZenRouteHandler(dependencies: ZenRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Zen API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Bootstrap: GET /api/zen
    if (url.pathname === "/api/zen" && request.method === "GET") {
      return handleZenBootstrap(request, url, origin, dependencies, now);
    }

    // Commands: POST /api/zen/command
    if (url.pathname === "/api/zen/command" && request.method === "POST") {
      return await handleZenCommand(request, url, origin, dependencies, now);
    }
    if (url.pathname === "/api/zen/spaces" && request.method === "POST") {
      return await handleZenFocusZoneCommand(request, url, origin, dependencies, now);
    }
    if (url.pathname === "/api/zen/threads" && request.method === "GET") {
      return await handleZenThreadSearch(request, url, origin, dependencies, now);
    }
    if (url.pathname === "/api/zen/threads/attach" && request.method === "POST") {
      return await handleZenThreadAttach(request, url, origin, dependencies, now);
    }
    if (url.pathname === "/api/zen/terminals/attach" && request.method === "POST") {
      return await handleZenTerminalAttach(request, url, origin, dependencies, now);
    }
    if (url.pathname === "/api/zen/threads/continue" && request.method === "GET") {
      return await handleZenThreadContinue(request, url, origin, dependencies, now);
    }
    if (
      url.pathname === "/api/zen/assistant" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return await handleZenAssistant(request, url, origin, dependencies, now);
    }

    return undefined;
  };
}

async function handleZenAssistant(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") return failureResponse("Navigator request is invalid.", 400, origin);
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Navigator", origin);
  }
  try {
    const snapshot =
      request.method === "POST"
        ? await deps.zenService.ensureAssistant(windowId)
        : await deps.zenService.assistantSnapshot(windowId);
    return jsonResponse(snapshot, origin);
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Navigator is unavailable.", 500, origin);
  }
}

function handleZenBootstrap(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Response {
  let authenticatedWindowId: WindowId;
  try {
    if (url.searchParams.has("windowId")) {
      return failureResponse("Zen bootstrap cannot supply window identity.", 400, origin);
    }
    authenticatedWindowId = authenticateRouteWindowId({
      request,
      store: deps.windowAuthorityStore,
      now: now(),
    });
  } catch (error) {
    if (error instanceof WindowAuthorityError) {
      return failureResponse("Zen bootstrap is unauthorized.", 401, origin);
    }
    return failureResponse("Zen bootstrap request is invalid.", 400, origin);
  }

  try {
    const response = deps.zenService.bootstrap(authenticatedWindowId);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  } catch {
    return failureResponse("Zen bootstrap failed.", 500, origin);
  }
}

async function handleZenCommand(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let authenticatedWindowId: WindowId;
  try {
    if (url.searchParams.has("windowId")) {
      return failureResponse("Zen command cannot supply window identity.", 400, origin);
    }
    authenticatedWindowId = authenticateRouteWindowId({
      request,
      store: deps.windowAuthorityStore,
      now: now(),
    });
  } catch (error) {
    if (error instanceof WindowAuthorityError) {
      return failureResponse("Zen command is unauthorized.", 401, origin);
    }
    return failureResponse("Zen command request is invalid.", 400, origin);
  }

  // Parse command body
  let command: ZenCommand;
  try {
    const body = await request.json();
    command = decodeZenCommand(body);
  } catch {
    return failureResponse("Zen command body is invalid.", 400, origin);
  }

  // Reject caller-supplied source context in thread elements
  if (
    (command.command === "add-element" || command.command === "update-element") &&
    command.element.kind === "thread"
  ) {
    return failureResponse(
      "Zen does not accept caller-supplied source context for thread elements.",
      400,
      origin,
    );
  }
  if (
    (command.command === "add-element" || command.command === "update-element") &&
    command.element.kind === "terminal"
  ) {
    return failureResponse(
      "Zen does not accept caller-supplied terminal cards; a terminal is pinned by naming it.",
      400,
      origin,
    );
  }
  if (command.command === "add-element" && command.element.kind === "timer") {
    return failureResponse("Zen timer state is server-authoritative.", 400, origin);
  }
  if (command.command === "bind-assistant") {
    return failureResponse("Navigator binding is server-authoritative.", 400, origin);
  }
  if (
    command.command === "add-element" &&
    (command.element.kind === "notes" || command.element.kind === "checklist")
  ) {
    return failureResponse("Zen widget identities are server-authoritative.", 400, origin);
  }

  try {
    const result = deps.zenService.handleCommand(command, authenticatedWindowId, request.signal);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", ...corsHeaders(origin) },
    });
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen command failed.", 500, origin);
  }
}

/**
 * Add, rename, reorder, remove, or switch the spaces one window holds.
 *
 * Separate from `/api/zen/command` because those commands act on the space in
 * front, while these decide which space that is. Both authenticate the same
 * way: the window proves its own identity and can only ever reach its own zone.
 */
async function handleZenFocusZoneCommand(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") return failureResponse("Zen space command is invalid.", 400, origin);
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Zen space command", origin);
  }
  let command;
  try {
    command = decodeZenFocusZoneCommand(await request.json());
  } catch {
    return failureResponse("Zen space command body is invalid.", 400, origin);
  }
  try {
    return jsonResponse(deps.zenService.focusZoneCommand(command, windowId), origin);
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen space command failed.", 500, origin);
  }
}

async function handleZenThreadSearch(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if ([...url.searchParams.keys()].some((key) => key !== "q")) {
      return failureResponse("Zen thread search is invalid.", 400, origin);
    }
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Zen thread search", origin);
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > 200) return failureResponse("Zen thread search is invalid.", 400, origin);
  try {
    const entries = await deps.zenService.searchThreads(windowId, query);
    return jsonResponse({ query, entries }, origin);
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen thread search failed.", 500, origin);
  }
}

async function handleZenThreadAttach(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") return failureResponse("Zen thread attachment is invalid.", 400, origin);
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Zen thread attachment", origin);
  }
  try {
    const body = decodeZenThreadAttachRequest(await request.json());
    return jsonResponse(await deps.zenService.attachThread(windowId, body), origin);
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen thread attachment is invalid.", 400, origin);
  }
}

/**
 * Pin a terminal one of this window's Code threads owns.
 *
 * Separate from the generic command route for the same reason thread elements
 * are: the caller names a terminal, and the server writes the card. There is no
 * body here that could describe a shell into existence.
 */
async function handleZenTerminalAttach(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") {
      return failureResponse("Zen terminal attachment is invalid.", 400, origin);
    }
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Zen terminal attachment", origin);
  }
  try {
    const body = decodeZenTerminalAttachRequest(await request.json());
    return jsonResponse(
      await deps.zenService.attachTerminal(windowId, body, request.signal),
      origin,
    );
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen terminal attachment is invalid.", 400, origin);
  }
}

async function handleZenThreadContinue(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ZenRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.searchParams.size !== 1 || !url.searchParams.has("ref")) {
      return failureResponse("Zen thread continuation is invalid.", 400, origin);
    }
    windowId = authenticateWindow(request, deps.windowAuthorityStore, now());
  } catch (error) {
    return authenticationFailure(error, "Zen thread continuation", origin);
  }
  try {
    const catalogRef = decodeZenThreadCatalogRef(url.searchParams.get("ref"));
    return jsonResponse(await deps.zenService.continueThread(windowId, catalogRef), origin);
  } catch (error) {
    if (error instanceof ZenError) return zenFailureResponse(error, origin);
    return failureResponse("Zen thread continuation is invalid.", 400, origin);
  }
}

function authenticateWindow(request: Request, store: WindowAuthorityStore, now: number): WindowId {
  return authenticateRouteWindowId({ request, store, now });
}

function authenticationFailure(error: unknown, action: string, origin: string | null): Response {
  return error instanceof WindowAuthorityError
    ? failureResponse(`${action} is unauthorized.`, 401, origin)
    : failureResponse(`${action} request is invalid.`, 400, origin);
}

function zenFailureResponse(error: ZenError, origin: string | null): Response {
  const status =
    error.reason === "stale-version" || error.reason === "stale-widget-version"
      ? 409
      : error.reason === "unavailable-source" || error.reason === "missing-capability"
        ? 503
        : 400;
  return failureResponse(error.message, status, origin);
}

function jsonResponse(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
