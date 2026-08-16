import {
  MAX_SIDEBAR_BACKGROUND_BYTES,
  SIDEBAR_BACKGROUND_MEDIA_TYPES,
  decodeSidebarBackgroundId,
  type SidebarBackground,
} from "@octant/contracts";
import { isLoopbackHostname, isAllowedRendererOrigin } from "../shellRoutes";
import {
  SidebarBackgroundInvalidFormat,
  SidebarBackgroundNotFound,
  SidebarBackgroundTooLarge,
  type SidebarBackgroundStore,
} from "./backgroundStore";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const METHODS = "GET, POST, DELETE, OPTIONS";
const HEADERS =
  "content-type, x-octant-window-capability, x-octant-sidebar-background-display-name";
const SUPPORTED_MEDIA_TYPES = new Set<string>(SIDEBAR_BACKGROUND_MEDIA_TYPES);

export interface SidebarBackgroundRouteDependencies {
  readonly store: SidebarBackgroundStore;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly currentSidebarBackground: () => SidebarBackground | null;
  readonly maxBodySize?: number;
  readonly now?: () => number;
}

export function createSidebarBackgroundRouteHandler(
  dependencies: SidebarBackgroundRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const maxBodySize = dependencies.maxBodySize ?? MAX_SIDEBAR_BACKGROUND_BYTES;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/theme/sidebar-backgrounds")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure(
        "unsupported",
        "Sidebar background API requests must use loopback.",
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("unsupported", "Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Authenticate via window capability token.
    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure(
          error.category === "invalid" ? "invalid" : "unauthorized",
          "Sidebar background request is unauthorized.",
          error.category === "invalid" ? 400 : 401,
          origin,
        );
      }
      return failure("unauthorized", "Sidebar background request is unauthorized.", 401, origin);
    }

    const isCollection = url.pathname === "/api/theme/sidebar-backgrounds";
    const itemMatch = /^\/api\/theme\/sidebar-backgrounds\/([^/]+)$/.exec(url.pathname);
    const metadataMatch = /^\/api\/theme\/sidebar-backgrounds\/([^/]+)\/metadata$/.exec(
      url.pathname,
    );

    try {
      if (isCollection && request.method === "POST") {
        return await handleUpload(request, dependencies.store, maxBodySize, origin);
      }
      if (isCollection && request.method === "GET") {
        return await handleList(dependencies.store, origin);
      }
      if (itemMatch !== null && request.method === "GET") {
        const id = decodeSidebarBackgroundId(itemMatch[1]!);
        return await handleRead(dependencies.store, id, origin);
      }
      if (metadataMatch !== null && request.method === "GET") {
        const id = decodeSidebarBackgroundId(metadataMatch[1]!);
        return await handleMetadata(dependencies.store, id, origin);
      }
      if (itemMatch !== null && request.method === "DELETE") {
        const id = decodeSidebarBackgroundId(itemMatch[1]!);
        return await handleDelete(
          dependencies.store,
          id,
          origin,
          dependencies.currentSidebarBackground,
        );
      }
      return failure("unsupported", "HTTP method is not supported for this route.", 400, origin);
    } catch (error) {
      if (error instanceof SidebarBackgroundTooLarge) {
        return failure("too-large", "Sidebar background is too large.", 413, origin);
      }
      if (error instanceof SidebarBackgroundNotFound) {
        return failure("unavailable", "Sidebar background not found.", 404, origin);
      }
      if (error instanceof SidebarBackgroundInvalidFormat) {
        return failure("invalid", error.message, 400, origin);
      }
      return failure("unavailable", "Sidebar background operation failed.", 503, origin);
    }
  };
}

async function handleUpload(
  request: Request,
  store: SidebarBackgroundStore,
  maxBodySize: number,
  origin: string | null,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBodySize) {
    return failure("too-large", "Sidebar background is too large.", 413, origin);
  }
  const mediaType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    return failure("invalid", "Sidebar background media type is unsupported.", 400, origin);
  }
  const encodedDisplayName = request.headers.get("x-octant-sidebar-background-display-name");
  if (encodedDisplayName === null || encodedDisplayName === "") {
    return failure("invalid", "Sidebar background display name is required.", 400, origin);
  }
  let displayName: string;
  try {
    displayName = decodeURIComponent(encodedDisplayName);
  } catch {
    return failure("invalid", "Sidebar background display name is invalid.", 400, origin);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodySize) {
    return failure("too-large", "Sidebar background is too large.", 413, origin);
  }
  const staged = await store.stage({ bytes, mediaType, displayName });
  const metadata = await store.finalize(staged.id);
  return jsonResponse(metadata, 200, origin);
}

async function handleList(store: SidebarBackgroundStore, origin: string | null): Promise<Response> {
  const list = await store.list();
  return jsonResponse({ backgrounds: list }, 200, origin);
}

async function handleRead(
  store: SidebarBackgroundStore,
  id: ReturnType<typeof decodeSidebarBackgroundId>,
  origin: string | null,
): Promise<Response> {
  const bytes = await store.read(id);
  const metadata = await store.metadata(id);
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      ...Object.fromEntries(corsHeaders(origin).entries()),
      "content-type": metadata.mediaType,
      "content-length": String(bytes.byteLength),
    },
  });
}

async function handleMetadata(
  store: SidebarBackgroundStore,
  id: ReturnType<typeof decodeSidebarBackgroundId>,
  origin: string | null,
): Promise<Response> {
  const metadata = await store.metadata(id);
  return jsonResponse(metadata, 200, origin);
}

async function handleDelete(
  store: SidebarBackgroundStore,
  id: ReturnType<typeof decodeSidebarBackgroundId>,
  origin: string | null,
  currentSidebarBackground: () => SidebarBackground | null,
): Promise<Response> {
  const active = currentSidebarBackground();
  if (active !== null && active.kind === "custom" && active.backgroundId === id) {
    return failure(
      "conflict",
      "Sidebar background is currently in use and cannot be deleted.",
      409,
      origin,
    );
  }
  await store.delete(id);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function failure(
  category: string,
  message: string,
  status: number,
  origin: string | null,
): Response {
  return Response.json({ category, message }, { status, headers: corsHeaders(origin) });
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
