import { createHash, timingSafeEqual } from "node:crypto";
import {
  decodeWindowId,
  decodeLaunchSessionExchangeRequest,
  decodeLaunchSessionRequest,
  type LaunchSessionFailure,
  type WindowId,
} from "@octant/contracts";
import { isAllowedRendererOrigin, isLocalRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { LaunchSessionError, type LaunchSessionStore } from "./launchSessionStore";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type";

export interface LaunchSessionRouteDependencies {
  readonly desktopBridgeSecret: string | undefined;
  readonly launchSessionStore: LaunchSessionStore;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly maxRequestBodySize?: number;
  readonly allowedRendererHttpOrigin?: string | null;
}

export function createLaunchSessionRouteHandler(dependencies: LaunchSessionRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const maxBody = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isAdminRoute = url.pathname === "/api/desktop/launch-sessions";
    const isExchangeRoute = url.pathname === "/api/shell/launch-session";
    const isLocalRoute = url.pathname === "/api/shell/local-session";
    if (!isAdminRoute && !isExchangeRoute && !isLocalRoute) return undefined;

    if (isAdminRoute) {
      return handleAdminCreate(request, url, dependencies, maxBody);
    }
    if (isLocalRoute) {
      return handleLocalBootstrap(request, url, dependencies, now, maxBody);
    }
    return handleRendererExchange(request, url, dependencies, now, maxBody);
  };
}

async function handleLocalBootstrap(
  request: Request,
  url: URL,
  dependencies: LaunchSessionRouteDependencies,
  now: () => number,
  maxBody: number,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!isLoopbackHostname(url.hostname)) {
    return failureResponse(
      { category: "invalid", message: "Local client bootstrap must use loopback." },
      origin,
      400,
    );
  }
  if (
    origin === null ||
    !isAllowedLocalRendererOrigin(origin, url, dependencies.allowedRendererHttpOrigin)
  ) {
    return failureResponse(
      { category: "invalid", message: "Renderer origin is not allowed." },
      null,
      400,
    );
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return failureResponse(
      { category: "invalid", message: "HTTP method is not supported for this route." },
      origin,
      400,
    );
  }
  const decoded = await readJson(request, maxBody);
  if (decoded.kind === "too-large") {
    return failureResponse(
      { category: "invalid", message: "Request body is too large." },
      origin,
      413,
    );
  }
  if (decoded.kind === "invalid") {
    return failureResponse(
      { category: "invalid", message: "Local client bootstrap request is invalid." },
      origin,
      400,
    );
  }
  // This route refreshes a window capability the caller already holds; it
  // never mints one. Being on loopback with an admitted Origin proves nothing
  // about who the caller is: another OS user, an SSH forward, or a proxy that
  // rewrites Host all arrive that way. A capability comes only from a launch
  // token minted with the bridge secret, which only the host's OS user can read.
  const previous = localAuthorityCandidate(decoded.value);
  if (previous !== undefined) {
    try {
      const authenticatedWindowId = dependencies.windowAuthorityStore.authenticate(
        previous.capability,
        now(),
      );
      if (String(authenticatedWindowId) === String(previous.windowId)) {
        dependencies.windowAuthorityStore.registerOrRefresh({ ...previous, now: now() });
        return jsonResponse({ ...previous, authentication: "local-session" as const }, 200, origin);
      }
    } catch (error) {
      if (error instanceof WindowAuthorityError && error.category === "unavailable") {
        return failureResponse(
          { category: "unavailable", message: "Local client session refresh is unavailable." },
          origin,
          503,
        );
      }
      // A restarted host owns no matching capability; the browser must be
      // launched again from the desktop application or `octant web`.
    }
  }
  return failureResponse(
    {
      category: "unauthorized",
      message: "Open Octant from the desktop app or run `octant web`.",
    },
    origin,
    401,
  );
}

function localAuthorityCandidate(
  value: unknown,
): { readonly windowId: WindowId; readonly capability: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { readonly windowId?: unknown; readonly capability?: unknown };
  if (typeof candidate.windowId !== "string" || typeof candidate.capability !== "string") {
    return undefined;
  }
  try {
    return { windowId: decodeWindowId(candidate.windowId), capability: candidate.capability };
  } catch {
    return undefined;
  }
}

// Launch tokens are bound to, and capabilities refreshed for, only renderers
// this listener serves; any other loopback page is refused first.
function isAllowedLocalRendererOrigin(
  origin: string,
  listenerUrl: URL,
  allowedHttpOrigin?: string | null,
): boolean {
  if (!isLocalRendererOrigin(origin, listenerUrl, allowedHttpOrigin)) return false;
  try {
    return new URL(origin).protocol === "http:";
  } catch {
    return false;
  }
}

async function handleAdminCreate(
  request: Request,
  url: URL,
  dependencies: LaunchSessionRouteDependencies,
  maxBody: number,
): Promise<Response> {
  if (dependencies.desktopBridgeSecret === undefined) {
    return failureResponse(
      { category: "unavailable", message: "Octant launch sessions are unavailable." },
      null,
      503,
    );
  }
  if (
    !isLoopbackHostname(url.hostname) ||
    request.headers.has("origin") ||
    !secretsEqual(
      dependencies.desktopBridgeSecret,
      request.headers.get("x-octant-desktop-secret") ?? "",
    )
  ) {
    return failureResponse(
      { category: "unauthorized", message: "Octant launch session creation is unauthorized." },
      null,
      401,
    );
  }
  if (request.method !== "POST") {
    return failureResponse(
      { category: "invalid", message: "HTTP method is not supported for this route." },
      null,
      400,
    );
  }
  if (url.search !== "") {
    return failureResponse(
      { category: "invalid", message: "Octant launch session request is invalid." },
      null,
      400,
    );
  }
  const decoded = await readJson(request, maxBody);
  if (decoded.kind === "too-large") {
    return failureResponse(
      { category: "invalid", message: "Request body is too large." },
      null,
      413,
    );
  }
  if (decoded.kind === "invalid") {
    return failureResponse(
      { category: "invalid", message: "Octant launch session request is invalid." },
      null,
      400,
    );
  }
  let body;
  try {
    body = decodeLaunchSessionRequest(decoded.value);
  } catch {
    return failureResponse(
      { category: "invalid", message: "Octant launch session request is invalid." },
      null,
      400,
    );
  }
  // The token is bound to the page the launcher opens, so that page must be a
  // renderer this listener serves.
  if (!isAllowedLocalRendererOrigin(body.origin, url, dependencies.allowedRendererHttpOrigin)) {
    return failureResponse(
      { category: "invalid", message: "Renderer origin is not allowed." },
      null,
      400,
    );
  }
  try {
    const receipt = dependencies.launchSessionStore.create({
      windowId: body.windowId,
      capability: body.capability,
      origin: body.origin,
    });
    return Response.json(receipt, { status: 201 });
  } catch (error) {
    const category = error instanceof LaunchSessionError ? error.category : "unavailable";
    return failureResponse(
      { category, message: "Octant launch session request is invalid." },
      null,
      category === "unavailable" ? 503 : 400,
    );
  }
}

async function handleRendererExchange(
  request: Request,
  url: URL,
  dependencies: LaunchSessionRouteDependencies,
  now: () => number,
  maxBody: number,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!isLoopbackHostname(url.hostname)) {
    return failureResponse(
      { category: "invalid", message: "Launch session requests must use loopback." },
      origin,
      400,
    );
  }
  if (origin !== null && !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)) {
    return failureResponse(
      { category: "invalid", message: "Renderer origin is not allowed." },
      null,
      400,
    );
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return failureResponse(
      { category: "invalid", message: "HTTP method is not supported for this route." },
      origin,
      400,
    );
  }
  const decoded = await readJson(request, maxBody);
  if (decoded.kind === "too-large") {
    return failureResponse(
      { category: "invalid", message: "Request body is too large." },
      origin,
      413,
    );
  }
  if (decoded.kind === "invalid") {
    return failureResponse(
      { category: "invalid", message: "Octant launch session request is invalid." },
      origin,
      400,
    );
  }
  let body;
  try {
    body = decodeLaunchSessionExchangeRequest(decoded.value);
  } catch {
    return failureResponse(
      { category: "invalid", message: "Octant launch session request is invalid." },
      origin,
      400,
    );
  }
  try {
    const exchange = dependencies.launchSessionStore.exchangeAtomically(
      { launchToken: body.launchToken, origin, now: now() },
      (candidate) => {
        dependencies.windowAuthorityStore.registerOrRefresh({
          windowId: candidate.windowId,
          capability: candidate.capability,
          now: now(),
        });
      },
    );
    return jsonResponse(exchange, 200, origin);
  } catch (error) {
    const rawCategory =
      error instanceof LaunchSessionError || error instanceof WindowAuthorityError
        ? error.category
        : "invalid";
    const category: LaunchSessionFailure["category"] =
      rawCategory === "conflict" ? "invalid" : rawCategory;
    return failureResponse(
      { category, message: "Octant launch session token is invalid or expired." },
      origin,
      category === "unavailable" ? 503 : 400,
    );
  }
}

function secretsEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
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

function failureResponse(
  failure: LaunchSessionFailure,
  origin: string | null,
  status: number,
): Response {
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

export type { WindowId };
