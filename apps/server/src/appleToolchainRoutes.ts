import {
  decodeAppleRpcEnvelope,
  type AppleAuthorityScopeRequest,
  type AppleRpcEnvelope,
  type WindowId,
} from "@octant/contracts";
import type { AppleExecutionContext, AppleToolchainService } from "./apple/appleToolchainService";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;

export interface AppleToolchainRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<AppleToolchainService, "discover" | "execute" | "cancel" | "snapshot">;
  readonly resolveContext: (
    windowId: WindowId,
    scope: AppleAuthorityScopeRequest,
    envelope: AppleRpcEnvelope,
  ) => Promise<AppleExecutionContext | undefined> | AppleExecutionContext | undefined;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  readonly nowIso?: () => string;
  readonly recordEvidence?: (
    evidence: import("@octant/contracts").AppleBuildEvidence,
    startedAt: string,
  ) => Promise<void> | void;
}

export function createAppleToolchainRouteHandler(dependencies: AppleToolchainRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const nowIso = dependencies.nowIso ?? (() => new Date().toISOString());
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/apple/toolchain") return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return failure(
        "invalid",
        "Apple toolchain requests must use an allowed loopback origin.",
        400,
        origin,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (
      request.method !== "POST" ||
      url.search !== "" ||
      request.headers.get("content-type")?.toLowerCase() !== "application/json"
    ) {
      return failure("invalid", "Apple toolchain request is invalid.", 400, origin);
    }
    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return failure(
        error instanceof WindowAuthorityError ? "unauthorized" : "invalid",
        "Apple toolchain request is unauthorized.",
        401,
        origin,
      );
    }
    const body = await readJson(request, bodyLimit);
    if (body.kind !== "ok") {
      return failure(
        "invalid",
        body.kind === "too-large"
          ? "Apple toolchain request body is too large."
          : "Apple toolchain request body is invalid.",
        body.kind === "too-large" ? 413 : 400,
        origin,
      );
    }
    let envelope: AppleRpcEnvelope;
    try {
      envelope = decodeAppleRpcEnvelope(body.value);
    } catch {
      return failure("invalid", "Apple toolchain request is invalid.", 400, origin);
    }
    const scope = requestScope(envelope);
    if (scope === undefined) {
      return failure("invalid", "Apple toolchain request is invalid.", 400, origin);
    }
    let context: AppleExecutionContext | undefined;
    try {
      context = await dependencies.resolveContext(windowId, scope, envelope);
    } catch {
      context = undefined;
    }
    if (context === undefined) {
      return failure("unauthorized", "Apple toolchain request is unauthorized.", 403, origin);
    }
    try {
      switch (envelope.kind) {
        case "apple-discovery-request": {
          const result = await dependencies.service.discover(envelope.request, context);
          if (result.kind === "failure") {
            return encoded(
              { kind: "apple-failure", failure: result.failure },
              failureStatus(result.failure.category),
              origin,
            );
          }
          return encoded(
            {
              kind: "apple-discovery-snapshot",
              snapshot: {
                toolchain: result.toolchain,
                workspace: result.workspace,
                simulators: result.simulators,
              },
            },
            200,
            origin,
          );
        }
        case "apple-action-request": {
          const startedAt = nowIso();
          const evidence = await dependencies.service.execute(envelope.request, context);
          await dependencies.recordEvidence?.(evidence, startedAt);
          return encoded(
            {
              kind: "apple-action-evidence",
              evidence,
            },
            200,
            origin,
          );
        }
        case "apple-cancel-request":
          return encoded(
            {
              kind: "apple-cancelled",
              cancelled: await dependencies.service.cancel(envelope.cancellation, context),
            },
            200,
            origin,
          );
        case "apple-snapshot-request":
          return encoded(
            { kind: "apple-runtime-snapshot", snapshot: dependencies.service.snapshot(context) },
            200,
            origin,
          );
        default:
          return failure("invalid", "Apple toolchain request is invalid.", 400, origin);
      }
    } catch {
      return failure("unavailable", "Apple toolchain service is unavailable.", 503, origin);
    }
  };
}

function requestScope(envelope: AppleRpcEnvelope): AppleAuthorityScopeRequest | undefined {
  switch (envelope.kind) {
    case "apple-discovery-request":
    case "apple-action-request":
      return {
        authority: envelope.request.authority,
        threadId: envelope.request.threadId,
        checkoutId: envelope.request.checkoutId,
      };
    case "apple-cancel-request":
      return {
        authority: envelope.cancellation.authority,
        threadId: envelope.threadId,
        checkoutId: envelope.checkoutId,
      };
    case "apple-snapshot-request":
      return {
        authority: envelope.authority,
        threadId: envelope.threadId,
        checkoutId: envelope.checkoutId,
      };
    default:
      return undefined;
  }
}

function encoded(body: AppleRpcEnvelope, status: number, origin: string | null): Response {
  const payload = decodeAppleRpcEnvelope(body);
  return Response.json(payload, {
    status,
    headers: corsHeaders(origin),
  });
}

function failure(
  category: "invalid" | "unauthorized" | "unavailable",
  message: string,
  status: number,
  origin: string | null,
): Response {
  return encoded({ kind: "apple-failure", failure: { category, message } }, status, origin);
}

function failureStatus(category: string): number {
  if (category === "unauthorized" || category === "approval-denied") return 403;
  if (category === "invalid" || category === "simulator-not-found") return 400;
  return 503;
}

async function readJson(
  request: Request,
  maximumBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    vary: "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    ...(origin === null || !isAllowedRendererOrigin(origin)
      ? {}
      : { "access-control-allow-origin": origin }),
  };
}
