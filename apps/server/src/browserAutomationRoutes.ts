import {
  decodeBrowserActionCommand,
  decodeBrowserAutomationSnapshot,
  decodeBrowserContextCancelCommand,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadScope,
  decodeBrowserThreadContextCommand,
  decodeBrowserThreadScopeRequest,
} from "@octant/contracts/browser-automation-rpc";
import {
  decodeBrowserAutomationFailure,
  type BrowserAutomationFailure,
} from "@octant/contracts/browser-automation";
import type {
  BrowserAuthorityResolver,
  BrowserAutomationService,
} from "./browser/browserAutomationService";
import { remoteBrowserActionReach } from "@octant/domain";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isAllowedRendererOrigin } from "./shellRoutes";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

const PREFIX = "/api/browser/";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface BrowserAutomationRouteDependencies {
  readonly service: Pick<
    BrowserAutomationService,
    "create" | "act" | "cancel" | "stop" | "inspect" | "inspectThread" | "releaseThread"
  >;
  readonly authority: BrowserAuthorityResolver;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize: number;
}

export function createBrowserAutomationRouteHandler(
  dependencies: BrowserAutomationRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure({ category: "unauthorized", message: "Browser origin is not allowed." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failure(
        { category: "invalid", message: "Browser route method is invalid." },
        405,
        origin,
      );
    }

    let windowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: Date.now(),
      });
    } catch {
      return failure(
        { category: "unauthorized", message: "Window authority is invalid." },
        401,
        origin,
      );
    }
    const decoded = await readJson(request, dependencies.maxRequestBodySize);
    if (decoded.kind !== "ok") {
      return failure(
        {
          category: "invalid",
          message:
            decoded.kind === "too-large"
              ? "Browser request is too large."
              : "Browser request is invalid.",
        },
        decoded.kind === "too-large" ? 413 : 400,
        origin,
      );
    }

    try {
      if (url.pathname === "/api/browser/scope") {
        const input = decodeBrowserThreadScopeRequest(decoded.value);
        const authority = dependencies.authority.resolve(input.threadId, input.mode);
        if (authority === undefined) {
          return failure(
            { category: "unauthorized", message: "Browser thread authority is unavailable." },
            403,
            origin,
          );
        }
        return success(decodeBrowserThreadScope({ threadId: input.threadId, authority }), origin);
      }
      if (url.pathname === "/api/browser/contexts") {
        const input = decodeBrowserContextCreateCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.create({ windowId, ...input }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/inspect") {
        const input = decodeBrowserContextInspectCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            dependencies.service.inspect(windowId, input.threadId, input.contextId),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/current") {
        const input = decodeBrowserThreadContextCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            dependencies.service.inspectThread(windowId, input.threadId),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/release") {
        const input = decodeBrowserThreadContextCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.releaseThread(windowId, input.threadId),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/actions") {
        const input = decodeBrowserActionCommand(decoded.value);
        // A paired device acts inside the view the host opened. The gateway
        // already admitted this route for a remote principal; the kind it may
        // carry is decided here, where the principal is known, so a companion
        // client can never navigate, type, or close a tab on the host.
        if (readPrincipalRouteContext(request)?.principal.kind === "remote-device") {
          const reach = remoteBrowserActionReach(input.kind);
          if (reach.kind === "denied") {
            return failure({ category: "unauthorized", message: reach.reason }, 403, origin);
          }
        }
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.act({ windowId, request: input }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/cancel") {
        const input = decodeBrowserContextCancelCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.cancel({ windowId, ...input }),
          ),
          origin,
        );
      }
      if (url.pathname === "/api/browser/contexts/stop") {
        const input = decodeBrowserContextStopCommand(decoded.value);
        return success(
          decodeBrowserAutomationSnapshot(
            await dependencies.service.stop(windowId, input.threadId, input.contextId),
          ),
          origin,
        );
      }
      return undefined;
    } catch (error) {
      if (error instanceof Error && /stale|unknown/i.test(error.message)) {
        return failure(
          { category: "stale", message: "Browser context is stale or no longer owned." },
          409,
          origin,
        );
      }
      if (error instanceof Error && /ParseError/.test(error.name)) {
        return failure(
          { category: "invalid", message: "Browser request is invalid." },
          400,
          origin,
        );
      }
      return failure(
        { category: "failed", message: "Browser automation service failed closed." },
        503,
        origin,
      );
    }
  };
}

function success(value: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(
  input: BrowserAutomationFailure,
  status: number,
  origin?: string | null,
): Response {
  return new Response(JSON.stringify(decodeBrowserAutomationFailure(input)), {
    status,
    headers: {
      "content-type": "application/json",
      ...(origin === undefined ? {} : corsHeaders(origin)),
    },
  });
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
    return { kind: "ok", value: text === "" ? {} : JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}
