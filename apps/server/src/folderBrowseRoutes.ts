import type { FolderBrowseFailure } from "@octant/contracts/folder-browse";
import { FolderBrowseServiceError, type FolderBrowseService } from "./folderBrowseService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface FolderBrowseRouteDependencies {
  readonly service: FolderBrowseService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function failureResponse(failure: FolderBrowseFailure, origin: string | null): Response {
  const status =
    failure.category === "unauthorized"
      ? 401
      : failure.category === "not-found"
        ? 404
        : failure.category === "unavailable"
          ? 503
          : 400;
  return Response.json(failure, { status, headers: corsHeaders(origin) });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
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

export function createFolderBrowseRouteHandler(dependencies: FolderBrowseRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isBrowse = url.pathname === "/api/folders/browse";
    const isSelect = url.pathname === "/api/folders/select";
    if (!isBrowse && !isSelect) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "invalid", message: "Folder browse requests must use loopback." },
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { category: "invalid", message: "Renderer origin is not allowed." },
        origin,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failureResponse(
        { category: "invalid", message: "Folder browse requires POST." },
        origin,
      );
    }

    let windowId;
    try {
      windowId = dependencies.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { category: "unauthorized", message: "Folder browse is unauthorized." },
          origin,
        );
      }
      return failureResponse(
        { category: "invalid", message: "Folder browse request is invalid." },
        origin,
      );
    }

    const decoded = await readJson(request, bodyLimit);
    if (decoded.kind === "too-large") {
      return failureResponse(
        { category: "invalid", message: "Request body is too large." },
        origin,
      );
    }
    if (decoded.kind === "invalid") {
      return failureResponse(
        { category: "invalid", message: "Request body must be valid JSON." },
        origin,
      );
    }

    try {
      if (isBrowse) {
        const result = await dependencies.service.browse(windowId, decoded.value);
        return Response.json(result, { status: 200, headers: corsHeaders(origin) });
      }
      const result = await dependencies.service.select(windowId, decoded.value);
      return Response.json(result, { status: 200, headers: corsHeaders(origin) });
    } catch (error) {
      if (error instanceof FolderBrowseServiceError) {
        return failureResponse(error.failure, origin);
      }
      return failureResponse(
        { category: "unavailable", message: "Folder browse service is unavailable." },
        origin,
      );
    }
  };
}
