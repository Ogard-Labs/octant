import { timingSafeEqual } from "node:crypto";
import type { WindowId } from "@octant/contracts";
import {
  decodePreviewHandoffRequest,
  type PreviewHandoffKind,
  type PreviewTarget,
} from "@octant/contracts/previews";
import type { PreviewHandoffResolution } from "./preview/previewService";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PreviewHandoffBridgeResolveInput {
  readonly windowId: WindowId;
  readonly target: PreviewTarget;
  readonly kind: PreviewHandoffKind;
  readonly signal?: AbortSignal;
}

/**
 * Authenticated desktop-bridge route for external-application preview
 * handoff. The native desktop executor is the only caller: it holds the
 * shared desktop bridge secret, so the resolved confined absolute path is
 * returned to it for Finder reveal / Quick Look / open-external execution.
 * Error responses never carry a path, secret, or opaque ref so a failed
 * handoff cannot leak host filesystem or capability details.
 */
export function createPreviewHandoffBridgeRouteHandler(options: {
  readonly desktopBridgeSecret: string | undefined;
  readonly resolve: (input: PreviewHandoffBridgeResolveInput) => Promise<PreviewHandoffResolution>;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/desktop/preview-handoff") return undefined;
    if (
      options.desktopBridgeSecret === undefined ||
      url.hostname !== "127.0.0.1" ||
      request.headers.has("origin") ||
      !equal(options.desktopBridgeSecret, request.headers.get("x-octant-desktop-secret") ?? "")
    ) {
      return failure("unauthorized", 401);
    }
    if (request.method !== "POST" || url.search !== "") return failure("invalid", 400);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("invalid", 400);
    }
    if (!record(body) || !exact(body, ["windowId", "target", "kind"])) {
      return failure("invalid", 400);
    }
    if (typeof body.windowId !== "string" || !UUID.test(body.windowId)) {
      return failure("invalid", 400);
    }
    let decoded: { readonly target: PreviewTarget; readonly kind: PreviewHandoffKind };
    try {
      decoded = decodePreviewHandoffRequest({ target: body.target, kind: body.kind });
    } catch {
      return failure("invalid", 400);
    }

    let resolution: PreviewHandoffResolution;
    try {
      resolution = await options.resolve({
        windowId: body.windowId as WindowId,
        target: decoded.target,
        kind: decoded.kind,
        signal: request.signal,
      });
    } catch {
      return failure("unavailable", 503);
    }
    if (resolution.kind === "resolved") {
      return Response.json({
        handoffKind: resolution.handoffKind,
        path: resolution.absolutePath,
      });
    }
    if (resolution.kind === "failed") return failure("unavailable", 503);
    // Unauthorized and unavailable are indistinguishable to the desktop so a
    // revoked window cannot probe target existence through the bridge.
    return failure("unavailable", 404);
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function failure(category: string, status: number): Response {
  return Response.json({ category, message: "Preview handoff is unavailable." }, { status });
}
