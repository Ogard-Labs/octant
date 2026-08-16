import { decodeZenSpaceId } from "@octant/contracts";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ZenService } from "./zen/zenService";
import type { WindowId, ZenSpaceId } from "@octant/contracts";
import {
  MAX_ZEN_BACKGROUND_BYTES,
  ZenBackgroundStore,
  ZenBackgroundStoreError,
} from "./zen/zenBackgroundStore";

export { MAX_ZEN_BACKGROUND_BYTES } from "./zen/zenBackgroundStore";

export class ZenBackgroundRequestError extends Error {
  constructor(readonly reason: "too-large" | "interrupted") {
    super(`Zen background request ${reason}.`);
    this.name = "ZenBackgroundRequestError";
  }
}

export interface ZenBackgroundRouteDependencies {
  readonly store: ZenBackgroundStore;
  readonly zenService: ZenService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly liveAssets: () => ReadonlyMap<
    string,
    { readonly ownerWindowId: WindowId; readonly spaceId: ZenSpaceId }
  >;
}

export function createZenBackgroundRouteHandler(dependencies: ZenBackgroundRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  let startupReconciled = false;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/zen/backgrounds")) return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return failure("invalid", "Zen background request is not allowed.", 400, origin);
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });
    let windowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      const status =
        error instanceof WindowAuthorityError && error.category === "invalid" ? 400 : 401;
      return failure(
        status === 400 ? "invalid" : "unauthorized",
        "Zen background request is unauthorized.",
        status,
        origin,
      );
    }
    const item = /^\/api\/zen\/backgrounds\/([^/]+)$/.exec(url.pathname)?.[1];
    try {
      if (!startupReconciled) {
        await dependencies.store.reconcile(dependencies.liveAssets());
        startupReconciled = true;
      }
      if (request.method === "POST" && item === undefined)
        return await upload(request, dependencies, windowId, origin);
      if (request.method === "GET" && item !== undefined) {
        const result = await dependencies.store.read(item, windowId);
        return new Response(Buffer.from(result.bytes), {
          status: 200,
          headers: {
            ...Object.fromEntries(cors(origin)),
            "content-type": result.metadata.mediaType,
            "content-length": String(result.bytes.byteLength),
            "cache-control": "no-store",
          },
        });
      }
      if (request.method === "DELETE" && item !== undefined) {
        const space = dependencies.zenService.bootstrap(windowId).space;
        if (
          space?.appearance.background.kind === "image" &&
          (space.appearance.background.assetId === item ||
            space.appearance.background.stillAssetId === item)
        ) {
          return failure("conflict", "Active Zen background cannot be deleted.", 409, origin);
        }
        await dependencies.store.delete(item, windowId);
        return new Response(null, { status: 204, headers: cors(origin) });
      }
      return failure("unsupported", "Zen background operation is unsupported.", 400, origin);
    } catch (error) {
      if (error instanceof ZenBackgroundRequestError) {
        return failure(
          error.reason,
          error.reason === "too-large"
            ? "Zen background is too large."
            : "Zen background upload was interrupted.",
          error.reason === "too-large" ? 413 : 499,
          origin,
        );
      }
      if (error instanceof ZenBackgroundStoreError) {
        return failure(
          error.reason,
          error.reason === "too-large"
            ? "Zen background is too large."
            : "Zen background is unavailable.",
          error.reason === "too-large" ? 413 : error.reason === "invalid" ? 400 : 404,
          origin,
        );
      }
      return failure("unavailable", "Zen background operation failed.", 503, origin);
    }
  };
}

async function upload(
  request: Request,
  dependencies: ZenBackgroundRouteDependencies,
  windowId: ReturnType<WindowAuthorityStore["authenticate"]>,
  origin: string | null,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ZEN_BACKGROUND_BYTES)
    return failure("too-large", "Zen background is too large.", 413, origin);
  const spaceId = decodeZenSpaceId(request.headers.get("x-octant-zen-space-id") ?? "");
  const expectedVersion = Number(request.headers.get("x-octant-zen-expected-version"));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
    return failure("invalid", "Zen background version is invalid.", 400, origin);
  const displayName = request.headers.get("x-octant-zen-background-display-name");
  if (displayName === null)
    return failure("invalid", "Zen background name is required.", 400, origin);
  const mediaType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const bytes = await readRequestBodyWithinLimit(request, MAX_ZEN_BACKGROUND_BYTES);
  const current = dependencies.zenService.bootstrap(windowId).space;
  if (current === null || current.spaceId !== spaceId || current.version !== expectedVersion)
    return failure("conflict", "Zen background changed elsewhere.", 409, origin);
  const metadata = await dependencies.store.stage({
    bytes,
    mediaType,
    displayName,
    ownerWindowId: windowId,
    spaceId,
  });
  try {
    const result = dependencies.zenService.handleCommand(
      {
        command: "update-appearance",
        spaceId,
        appearance: {
          ...current.appearance,
          background: {
            kind: "image",
            assetId: metadata.assetId,
            ...(metadata.stillAssetId === undefined ? {} : { stillAssetId: metadata.stillAssetId }),
            overlay:
              current.appearance.background.kind === "image" ||
              current.appearance.background.kind === "builtin"
                ? current.appearance.background.overlay
                : 40,
            fill:
              current.appearance.background.kind === "image" ||
              current.appearance.background.kind === "builtin"
                ? current.appearance.background.fill
                : "cover",
          },
        },
        expectedVersion: current.version,
      },
      windowId,
    );
    if (result.result !== "mutation") throw new Error("Zen background update failed.");
    await dependencies.store.reconcile(dependencies.liveAssets(), {
      ownerWindowId: windowId,
      spaceId,
    });
    return Response.json(
      { background: metadata, space: result.space },
      { status: 200, headers: cors(origin) },
    );
  } catch (error) {
    await dependencies.store.reconcile(dependencies.liveAssets(), {
      ownerWindowId: windowId,
      spaceId,
    });
    throw error;
  }
}

export async function readRequestBodyWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (request.signal.aborted) throw new ZenBackgroundRequestError("interrupted");
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const abort = async () => {
    await reader.cancel().catch(() => undefined);
    throw new ZenBackgroundRequestError("interrupted");
  };
  try {
    while (true) {
      if (request.signal.aborted) await abort();
      const next = await reader.read();
      if (request.signal.aborted) await abort();
      if (next.done) break;
      if (byteLength + next.value.byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ZenBackgroundRequestError("too-large");
      }
      chunks.push(next.value);
      byteLength += next.value.byteLength;
    }
  } catch (error) {
    if (error instanceof ZenBackgroundRequestError) throw error;
    await reader.cancel().catch(() => undefined);
    throw new ZenBackgroundRequestError(request.signal.aborted ? "interrupted" : "too-large");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function failure(
  category: string,
  message: string,
  status: number,
  origin: string | null,
): Response {
  return Response.json({ category, message }, { status, headers: cors(origin) });
}

function cors(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, x-octant-window-capability, x-octant-zen-space-id, x-octant-zen-expected-version, x-octant-zen-background-display-name",
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}
