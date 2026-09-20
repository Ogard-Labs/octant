import {
  decodeAndroidArtifactRequest,
  decodeAndroidRpcEnvelope,
  decodeAndroidRuntimeSnapshot,
  decodeAndroidScreenStreamRequest,
  SIMULATOR_SCREEN_HEADER,
  type AndroidEmulatorEvidence,
  type AndroidEmulatorRequest,
  type AndroidRpcEnvelope,
  type WindowId,
} from "@octant/contracts";
import type {
  AndroidExecutionContext,
  AndroidToolchainService,
} from "./android/androidToolchainService";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;

export interface AndroidToolchainRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<
    AndroidToolchainService,
    "discover" | "execute" | "cancel" | "snapshot" | "readScreenshotArtifact" | "watchScreen"
  >;
  readonly resolveContext: (
    windowId: WindowId,
    scope: {
      readonly authority: AndroidEmulatorRequest["authority"];
      readonly threadId: AndroidEmulatorRequest["threadId"];
      readonly checkoutId: AndroidEmulatorRequest["checkoutId"];
    },
    envelope: AndroidRpcEnvelope,
  ) => Promise<AndroidExecutionContext | undefined> | AndroidExecutionContext | undefined;
  readonly afterAction?: (
    windowId: WindowId,
    request: AndroidEmulatorRequest,
    evidence: AndroidEmulatorEvidence,
    context: AndroidExecutionContext,
  ) => void;
  readonly inputGrants?: (
    windowId: WindowId,
    threadId: AndroidExecutionContext["threadId"],
  ) => ReadonlyArray<{ readonly emulatorId: string; readonly expiresAt: string }>;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createAndroidToolchainRouteHandler(dependencies: AndroidToolchainRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/android/toolchain" &&
      url.pathname !== "/api/android/artifacts" &&
      url.pathname !== "/api/android/screen-stream"
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin))) {
      return failure(
        "invalid",
        "Android toolchain requests must use an allowed loopback origin.",
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
      return failure("invalid", "Android toolchain request is invalid.", 400, origin);
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
        "Android toolchain request is unauthorized.",
        401,
        origin,
      );
    }
    const body = await readJson(request, bodyLimit);
    if (body.kind !== "ok") {
      return failure(
        "invalid",
        body.kind === "too-large"
          ? "Android toolchain request body is too large."
          : "Android toolchain request body is invalid.",
        body.kind === "too-large" ? 413 : 400,
        origin,
      );
    }
    if (url.pathname === "/api/android/screen-stream") {
      return await handleScreenStreamRequest({
        body: body.value,
        origin,
        windowId,
        signal: request.signal,
        resolveContext: dependencies.resolveContext,
        watchScreen: (emulatorId, context, signal) =>
          dependencies.service.watchScreen(emulatorId, context, signal),
      });
    }
    if (url.pathname === "/api/android/artifacts") {
      return await handleArtifactRequest({
        body: body.value,
        origin,
        windowId,
        resolveContext: dependencies.resolveContext,
        service: dependencies.service,
      });
    }
    let envelope: AndroidRpcEnvelope;
    try {
      envelope = decodeAndroidRpcEnvelope(body.value);
    } catch {
      return failure("invalid", "Android toolchain request is invalid.", 400, origin);
    }
    const scope = requestScope(envelope);
    if (scope === undefined) {
      return failure("invalid", "Android toolchain request is invalid.", 400, origin);
    }
    let context: AndroidExecutionContext | undefined;
    try {
      context = await dependencies.resolveContext(windowId, scope, envelope);
    } catch {
      context = undefined;
    }
    if (context === undefined) {
      return failure("unauthorized", "Android toolchain request is unauthorized.", 403, origin);
    }
    try {
      switch (envelope.kind) {
        case "android-discovery-request": {
          const result = await dependencies.service.discover(envelope.request, context);
          if (result.kind === "failure") {
            return encoded(
              { kind: "android-failure", failure: result.failure },
              failureStatus(result.failure.category),
              origin,
            );
          }
          return encoded(
            {
              kind: "android-discovery-snapshot",
              snapshot: { sdk: result.sdk, emulators: result.emulators },
            },
            200,
            origin,
          );
        }
        case "android-action-request": {
          const evidence = await dependencies.service.execute(envelope.request, context);
          dependencies.afterAction?.(windowId, envelope.request, evidence, context);
          return encoded({ kind: "android-action-evidence", evidence }, 200, origin);
        }
        case "android-cancel-request":
          return encoded(
            {
              kind: "android-cancelled",
              cancelled: await dependencies.service.cancel(envelope.cancellation, context),
            },
            200,
            origin,
          );
        case "android-snapshot-request": {
          const inputGrants = dependencies.inputGrants?.(windowId, context.threadId) ?? [];
          return encoded(
            {
              kind: "android-runtime-snapshot",
              snapshot:
                inputGrants.length === 0
                  ? dependencies.service.snapshot(context)
                  : decodeAndroidRuntimeSnapshot({
                      ...dependencies.service.snapshot(context),
                      inputGrants,
                    }),
            },
            200,
            origin,
          );
        }
        default:
          return failure("invalid", "Android toolchain request is invalid.", 400, origin);
      }
    } catch {
      return failure("unavailable", "Android toolchain service is unavailable.", 503, origin);
    }
  };
}

async function handleScreenStreamRequest(input: {
  readonly body: unknown;
  readonly origin: string | null;
  readonly windowId: WindowId;
  readonly signal: AbortSignal;
  readonly resolveContext: AndroidToolchainRouteDependencies["resolveContext"];
  readonly watchScreen: AndroidToolchainService["watchScreen"];
}): Promise<Response> {
  let request;
  try {
    request = decodeAndroidScreenStreamRequest(input.body);
  } catch {
    return failure("invalid", "Android toolchain request is invalid.", 400, input.origin);
  }
  const envelope: AndroidRpcEnvelope = {
    kind: "android-snapshot-request",
    authority: request.authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
  };
  let context: AndroidExecutionContext | undefined;
  try {
    context = await input.resolveContext(input.windowId, request, envelope);
  } catch {
    context = undefined;
  }
  if (context === undefined) {
    return failure("unauthorized", "Android toolchain request is unauthorized.", 403, input.origin);
  }
  const watch = await input.watchScreen(String(request.emulatorId), context, input.signal);
  if (watch.kind !== "watching") {
    return failure("unavailable", watch.message, 409, input.origin);
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
  readonly resolveContext: AndroidToolchainRouteDependencies["resolveContext"];
  readonly service: AndroidToolchainRouteDependencies["service"];
}): Promise<Response> {
  let request;
  try {
    request = decodeAndroidArtifactRequest(input.body);
  } catch {
    return failure("invalid", "Android toolchain request is invalid.", 400, input.origin);
  }
  const envelope: AndroidRpcEnvelope = {
    kind: "android-snapshot-request",
    authority: request.authority,
    threadId: request.threadId,
    checkoutId: request.checkoutId,
  };
  let context: AndroidExecutionContext | undefined;
  try {
    context = await input.resolveContext(input.windowId, request, envelope);
  } catch {
    context = undefined;
  }
  if (context === undefined) {
    return failure("unauthorized", "Android toolchain request is unauthorized.", 403, input.origin);
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
    return failure("unavailable", "Android toolchain service is unavailable.", 503, input.origin);
  }
}

function requestScope(
  envelope: AndroidRpcEnvelope,
):
  | {
      readonly authority: AndroidEmulatorRequest["authority"];
      readonly threadId: AndroidEmulatorRequest["threadId"];
      readonly checkoutId: AndroidEmulatorRequest["checkoutId"];
    }
  | undefined {
  switch (envelope.kind) {
    case "android-discovery-request":
    case "android-action-request":
      return {
        authority: envelope.request.authority,
        threadId: envelope.request.threadId,
        checkoutId: envelope.request.checkoutId,
      };
    case "android-cancel-request":
      return {
        authority: envelope.cancellation.authority,
        threadId: envelope.threadId,
        checkoutId: envelope.checkoutId,
      };
    case "android-snapshot-request":
      return {
        authority: envelope.authority,
        threadId: envelope.threadId,
        checkoutId: envelope.checkoutId,
      };
    default:
      return undefined;
  }
}

function encoded(body: AndroidRpcEnvelope, status: number, origin: string | null): Response {
  const payload = decodeAndroidRpcEnvelope(body);
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
  return encoded({ kind: "android-failure", failure: { category, message } }, status, origin);
}

function failureStatus(category: string): number {
  if (category === "unauthorized") return 403;
  if (category === "invalid" || category === "emulator-not-found") return 400;
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
