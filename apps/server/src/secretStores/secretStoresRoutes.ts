/**
 * Host-only routes for Settings › Secret stores: read which stores are linked,
 * link and unlink one, check an item reference, and point a provider's key at
 * an item.
 *
 * Linking a store and pointing a key at it are host authority: a paired phone
 * is refused even if transport policy regressed. Three layers keep the routes
 * off the remote listener - they answer only a loopback host name, they are
 * registered on the loopback chain outside the shared product dispatch, and
 * `/api/secret-stores` is a remote local-only prefix - and the principal check
 * refuses anything that is not a local window.
 *
 * A request carries a store name and an item reference, which names an item.
 * No request or answer carries what the item holds.
 */

import type { WindowId } from "@octant/contracts";
import {
  decodeSecretStoresCommand,
  type SecretStoresCommand,
} from "@octant/contracts/secret-stores";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { secretStoresRefusal, type SecretStoresService } from "./secretStoresService";

const ROUTES = {
  settings: "/api/secret-stores/settings",
  commands: "/api/secret-stores/commands",
} as const;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const JSON_BODY_LIMIT = 4_096;

export interface SecretStoresRouteDependencies {
  readonly service: SecretStoresService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** The development renderer origin, or null when the packaged file renderer is in use. */
  readonly allowedRendererHttpOrigin?: string | null;
  readonly now?: () => number;
}

export function createSecretStoresRouteHandler(dependencies: SecretStoresRouteDependencies) {
  const now = dependencies.now ?? Date.now;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTES.settings && url.pathname !== ROUTES.commands) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Secret store requests must use loopback.", 400, null);
    }
    if (
      origin !== null &&
      !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)
    ) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.search !== "") return failure("Secret store request is invalid.", 400, origin);
    const expectedMethod = url.pathname === ROUTES.settings ? "GET" : "POST";
    if (request.method !== expectedMethod) {
      return failure("HTTP method is not supported for this route.", 405, origin);
    }

    let body: unknown;
    if (expectedMethod === "POST") {
      const read = await readJson(request);
      if (read.kind === "too-large") return failure("Request body is too large.", 413, origin);
      if (read.kind === "invalid") return failure("Request body must be valid JSON.", 400, origin);
      body = read.value;
    }

    let windowId: WindowId;
    try {
      const context = authenticateRoutePrincipal({
        request,
        ...(body === undefined ? {} : { body }),
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window") {
        return failure("Secret stores are host-only.", 403, origin);
      }
      windowId = context.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Secret stores are unauthorized.", 401, origin);
      }
      return failure("Secret store request is invalid.", 400, origin);
    }

    try {
      if (expectedMethod === "GET") return json(await dependencies.service.view(), origin);
      let command: SecretStoresCommand;
      try {
        command = decodeSecretStoresCommand(body);
      } catch {
        return json(secretStoresRefusal("malformed"), origin);
      }
      return json(await run(dependencies.service, windowId, command), origin);
    } catch {
      return failure("Secret stores are unavailable.", 500, origin);
    }
  };
}

function run(service: SecretStoresService, windowId: WindowId, command: SecretStoresCommand) {
  switch (command.kind) {
    case "link-store":
      return service.linkStore(windowId, command.store);
    case "unlink-store":
      return service.unlinkStore(windowId, command.store);
    case "check-reference":
      return service.checkReference(command.store, command.reference);
    case "point-provider-key":
      return service.pointProviderKey(windowId, {
        instanceId: command.instanceId,
        store: command.store,
        reference: command.reference,
      });
    case "clear-provider-key-reference":
      return service.clearProviderKeyReference(windowId, command.instanceId);
    case "read-provider-key-reference":
      return service.readProviderKeyReference(command.instanceId);
  }
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

async function readJson(request: Request): Promise<ReadJsonResult> {
  const contentType = request.headers.get("content-type")?.trim().toLowerCase();
  if (contentType !== "application/json") return { kind: "invalid" };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > JSON_BODY_LIMIT) return { kind: "too-large" };
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > JSON_BODY_LIMIT) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  };
}

function json(body: unknown, origin: string | null): Response {
  return Response.json(body, { status: 200, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}
