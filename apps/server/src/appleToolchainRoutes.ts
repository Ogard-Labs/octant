import {
  decodeAppleArtifactRequest,
  decodeAppleRpcEnvelope,
  decodeAppleRuntimeSnapshot,
  decodeAppleScreenStreamRequest,
  SIMULATOR_SCREEN_HEADER,
  type AppleActionRequest,
  type AppleAuthorityScopeRequest,
  type AppleBuildEvidence,
  type AppleRpcEnvelope,
  type WindowId,
} from "@octant/contracts";
import type { AppleExecutionContext, AppleToolchainService } from "./apple/appleToolchainService";
import type { SimulatorScreenWatch } from "./apple/desktopSimulatorDevicePort";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;

export interface AppleToolchainRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<
    AppleToolchainService,
    "discover" | "execute" | "cancel" | "snapshot" | "readScreenshotArtifact"
  >;
  readonly resolveContext: (
    windowId: WindowId,
    scope: AppleAuthorityScopeRequest,
    envelope: AppleRpcEnvelope,
  ) => Promise<AppleExecutionContext | undefined> | AppleExecutionContext | undefined;
  /**
   * Called with what an action came to, after it ran. The host's input grants
   * follow what was delivered rather than what was asked.
   */
  readonly afterAction?: (
    request: AppleActionRequest,
    evidence: AppleBuildEvidence,
    context: AppleExecutionContext,
  ) => void;
  /** Simulators the thread may send input to without a new approval. */
  readonly inputGrants?: (
    threadId: AppleExecutionContext["threadId"],
  ) => ReadonlyArray<{ readonly simulatorId: string; readonly expiresAt: string }>;
  /**
   * Watches a Simulator's screen through the desktop's device helper. Absent on
   * a host the desktop app did not start, where there is no live view.
   */
  readonly watchSimulator?: (
    simulatorId: string,
    signal: AbortSignal,
  ) => Promise<SimulatorScreenWatch>;
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
    if (
      url.pathname !== "/api/apple/toolchain" &&
      url.pathname !== "/api/apple/artifacts" &&
      url.pathname !== "/api/apple/screen-stream"
    ) {
      return undefined;
    }
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
    if (url.pathname === "/api/apple/screen-stream") {
      return await handleScreenStreamRequest({
        body: body.value,
        origin,
        windowId,
        signal: request.signal,
        resolveContext: dependencies.resolveContext,
        watchSimulator: dependencies.watchSimulator,
      });
    }
    if (url.pathname === "/api/apple/artifacts") {
      return await handleArtifactRequest({
        body: body.value,
        origin,
        windowId,
        resolveContext: dependencies.resolveContext,
        service: dependencies.service,
      });
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
          dependencies.afterAction?.(envelope.request, evidence, context);
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
        case "apple-snapshot-request": {
          const inputGrants = dependencies.inputGrants?.(context.threadId) ?? [];
          return encoded(
            {
              kind: "apple-runtime-snapshot",
              // Decoded, not cast: the grants arrive as plain host strings and
              // leave as the contract's branded identifiers or not at all.
              snapshot:
                inputGrants.length === 0
                  ? dependencies.service.snapshot(context)
                  : decodeAppleRuntimeSnapshot({
                      ...dependencies.service.snapshot(context),
                      inputGrants,
                    }),
            },
            200,
            origin,
          );
        }
        default:
          return failure("invalid", "Apple toolchain request is invalid.", 400, origin);
      }
    } catch {
      return failure("unavailable", "Apple toolchain service is unavailable.", 503, origin);
    }
  };
}

/**
 * A live view is a read of the destination, authorized like a screenshot:
 * the window must hold the thread and checkout, and no approval is asked.
 */
async function handleScreenStreamRequest(input: {
  readonly body: unknown;
  readonly origin: string | null;
  readonly windowId: WindowId;
  readonly signal: AbortSignal;
  readonly resolveContext: AppleToolchainRouteDependencies["resolveContext"];
  readonly watchSimulator: AppleToolchainRouteDependencies["watchSimulator"];
}): Promise<Response> {
  let request;
  try {
    request = decodeAppleScreenStreamRequest(input.body);
  } catch {
    return failure("invalid", "Apple toolchain request is invalid.", 400, input.origin);
  }
  const envelope: AppleRpcEnvelope = {
    kind: "apple-snapshot-request",
    authority: request.authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
  };
  let context: AppleExecutionContext | undefined;
  try {
    context = await input.resolveContext(input.windowId, request, envelope);
  } catch {
    context = undefined;
  }
  if (context === undefined) {
    return failure("unauthorized", "Apple toolchain request is unauthorized.", 403, input.origin);
  }
  if (input.watchSimulator === undefined) {
    return failure(
      "unavailable",
      "A live Simulator view needs the Octant desktop app on the Mac that owns the destination.",
      404,
      input.origin,
    );
  }
  let watch: SimulatorScreenWatch;
  try {
    watch = await input.watchSimulator(String(request.simulatorId), input.signal);
  } catch {
    return failure("unavailable", "The live Simulator view is unavailable.", 503, input.origin);
  }
  if (watch.kind !== "watching") {
    return failure("unavailable", `${watch.reason}: ${watch.message}`, 409, input.origin);
  }
  return new Response(watch.frames, {
    status: 200,
    headers: {
      ...corsHeaders(input.origin),
      "access-control-expose-headers": SIMULATOR_SCREEN_HEADER,
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
      [SIMULATOR_SCREEN_HEADER]: `${watch.screen.width}x${watch.screen.height}`,
    },
  });
}

async function handleArtifactRequest(input: {
  readonly body: unknown;
  readonly origin: string | null;
  readonly windowId: WindowId;
  readonly resolveContext: AppleToolchainRouteDependencies["resolveContext"];
  readonly service: AppleToolchainRouteDependencies["service"];
}): Promise<Response> {
  let request;
  try {
    request = decodeAppleArtifactRequest(input.body);
  } catch {
    return failure("invalid", "Apple toolchain request is invalid.", 400, input.origin);
  }
  const envelope: AppleRpcEnvelope = {
    kind: "apple-snapshot-request",
    authority: request.authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
  };
  let context: AppleExecutionContext | undefined;
  try {
    context = await input.resolveContext(input.windowId, request, envelope);
  } catch {
    context = undefined;
  }
  if (context === undefined) {
    return failure("unauthorized", "Apple toolchain request is unauthorized.", 403, input.origin);
  }
  try {
    const artifact = await input.service.readScreenshotArtifact(request.reference, context);
    if (artifact.kind === "unauthorized") {
      return failure("unauthorized", artifact.message, 403, input.origin);
    }
    if (artifact.kind === "unavailable") {
      return failure("unavailable", artifact.message, 404, input.origin);
    }
    return new Response(Buffer.from(artifact.bytes), {
      status: 200,
      headers: {
        ...corsHeaders(input.origin),
        "content-type": "image/png",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return failure("unavailable", "Apple toolchain service is unavailable.", 503, input.origin);
  }
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
