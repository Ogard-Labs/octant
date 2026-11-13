import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { Schema } from "effect";
import type { EventActor } from "@octant/contracts";
import { PendingQuestionDeferral } from "@octant/contracts/pending-requests";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import {
  decodePendingRequestFailure,
  decodePendingRequestList,
  type PendingRequestList,
  type WindowId,
} from "@octant/contracts";
import { createLocalWindowReadRoute } from "./localWindowReadRoute";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

export const PENDING_REQUESTS_PATH = "/api/pending-requests";

export interface PendingRequestRouteDependencies {
  readonly service: {
    readonly defer?: (
      windowId: WindowId,
      change: PendingQuestionDeferral,
      current: () => boolean,
      actor?: EventActor,
    ) => Promise<boolean>;
    readonly list: (windowId: WindowId) => Promise<PendingRequestList>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/pending-requests`: every approval and question the calling window
 * can answer. Local windows only.
 */
export function createPendingRequestRouteHandler(dependencies: PendingRequestRouteDependencies) {
  const read = createLocalWindowReadRoute({
    path: PENDING_REQUESTS_PATH,
    noun: "Pending request",
    plural: "Pending requests",
    read: async (windowId) => decodePendingRequestList(await dependencies.service.list(windowId)),
    decodeFailure: decodePendingRequestFailure,
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== `${PENDING_REQUESTS_PATH}/defer`) return read(request);
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      url.search ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    )
      return new Response(null, { status: 403 });
    const headers = {
      "cache-control": "no-store",
      ...(origin === null ? {} : { "access-control-allow-origin": origin, vary: "Origin" }),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const reply = (status: number) =>
      Response.json({ status: status === 200 ? "accepted" : "refused" }, { status, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (
      request.method !== "POST" ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return reply(400);
    const authenticate = () =>
      authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: dependencies.now?.() ?? Date.now(),
      });
    let windowId: WindowId;
    let actor: EventActor;
    try {
      const context = authenticate();
      if (!principalActsAsHostPerson(context.principal)) return reply(403);
      windowId = context.scopeId;
      actor = eventActorForPrincipal(context.principal);
    } catch {
      return reply(401);
    }
    const reader = request.body?.getReader();
    if (reader === undefined) return reply(400);
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024) return reply(413);
        chunks.push(part.value);
      }
      const change = Schema.decodeUnknownSync(PendingQuestionDeferral)(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const current = () => {
        try {
          const context = authenticate();
          return (
            principalActsAsHostPerson(context.principal) &&
            String(context.scopeId) === String(windowId)
          );
        } catch {
          return false;
        }
      };
      if (!current()) return reply(401);
      return reply(
        (await dependencies.service.defer?.(windowId, change, current, actor)) ? 200 : 409,
      );
    } catch {
      return reply(400);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
}
