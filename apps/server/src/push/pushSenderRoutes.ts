// Loopback administration routes for any host's direct push sender
// (`/api/desktop/push-sender*`). Like hub administration routes, these answer
// only the local desktop bridge with an authenticated window capability and
// refuse any request carrying an Origin header. A paired device, peer, or hub
// never reaches them.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  decodeHubDirectPushCredentialRemoveRequest,
  decodeHubDirectPushCredentialRequest,
  decodeHubDirectPushEnvironmentRequest,
  decodeHubDirectPushSwitchRequest,
  type AuditActingPrincipal,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { PushSenderChangeOutcome, PushSenderService } from "./pushSenderService";

const DEFAULT_BODY_LIMIT = 64 * 1_024;
const WINDOW_PRINCIPAL: AuditActingPrincipal = { kind: "local-window" };

export const PUSH_SENDER_ROUTES = {
  status: "/api/desktop/push-sender",
  environment: "/api/desktop/push-sender/environment",
  credential: "/api/desktop/push-sender/credential",
  credentialRemove: "/api/desktop/push-sender/credential/remove",
} as const;

export interface PushSenderRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly pushSender: PushSenderService;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function failure(error: string, status: number): Response {
  return json({ error }, status);
}

function outcomeResponse(result: PushSenderChangeOutcome): Response {
  if (result.status === "changed") return json({ status: "changed" });
  const status = result.kind === "invalid-credential" ? 409 : 503;
  return json({ status: "refused", reason: result.kind }, status);
}

function hasBridgeSecret(request: Request, expected: string | undefined): boolean {
  const actual = request.headers.get("x-octant-desktop-secret");
  if (expected === undefined || expected.length === 0 || actual === null) return false;
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

async function readBody(
  request: Request,
  limit: number,
): Promise<{ readonly status: "ok"; readonly text: string } | { readonly status: "too-large" }> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) return { status: "too-large" };
  return { status: "ok", text: new TextDecoder().decode(bytes) };
}

export function createPushSenderRouteHandler(options: PushSenderRouteOptions) {
  const now = options.now ?? Date.now;
  const maxBodyBytes = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const paths = new Set<string>(Object.values(PUSH_SENDER_ROUTES));

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!paths.has(url.pathname)) return undefined;
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Push sender administration requests must use loopback.", 400);
    }
    if (request.headers.get("origin") !== null) {
      return failure("Cross-origin push sender administration requests are refused.", 403);
    }
    if (!hasBridgeSecret(request, options.desktopBridgeSecret)) {
      return failure("Desktop bridge authentication is required.", 403);
    }
    const capability = request.headers.get("x-octant-window-capability");
    if (capability === null || capability.trim() === "") {
      return failure("Window capability is required.", 401);
    }
    try {
      options.windowAuthorityStore.authenticate(capability, now());
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Window capability is invalid.", 401);
      }
      return failure("Window capability could not be verified.", 400);
    }

    if (url.pathname === PUSH_SENDER_ROUTES.status && request.method === "GET") {
      return json({ pushSender: await options.pushSender.status() });
    }
    if (request.method !== "POST") {
      return failure("Method not allowed.", 405);
    }

    const body = await readBody(request, maxBodyBytes);
    if (body.status === "too-large") return failure("Request body is too large.", 413);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return failure("Request body must be valid JSON.", 400);
    }

    try {
      switch (url.pathname) {
        case PUSH_SENDER_ROUTES.status: {
          const value = decodeHubDirectPushSwitchRequest(parsed);
          return outcomeResponse(options.pushSender.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case PUSH_SENDER_ROUTES.environment: {
          const value = decodeHubDirectPushEnvironmentRequest(parsed);
          return outcomeResponse(
            options.pushSender.setEnvironment(value.environment, WINDOW_PRINCIPAL),
          );
        }
        case PUSH_SENDER_ROUTES.credential: {
          const value = decodeHubDirectPushCredentialRequest(parsed);
          return outcomeResponse(await options.pushSender.storeCredential(value, WINDOW_PRINCIPAL));
        }
        case PUSH_SENDER_ROUTES.credentialRemove: {
          const value = decodeHubDirectPushCredentialRemoveRequest(parsed);
          return outcomeResponse(
            await options.pushSender.removeCredential(value.platform, WINDOW_PRINCIPAL),
          );
        }
        default:
          return undefined;
      }
    } catch {
      return failure("Request body is invalid.", 400);
    }
  };
}
