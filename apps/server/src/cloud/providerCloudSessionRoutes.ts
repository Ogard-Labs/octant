import {
  decodeProviderCloudRequest,
  decodeProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";
import { authenticateRoutePrincipal, retainRouteAdmissionCurrent } from "../principalRouteContext";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ProviderCloudPrincipal,
  ProviderCloudSessionService,
} from "./providerCloudSessionService";

export function createProviderCloudSessionRoutes(input: {
  readonly service: Pick<ProviderCloudSessionService, "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly isPersonPairedDeviceCurrent?: (
    deviceId: string,
    credentialGeneration: number,
    sessionId?: string,
  ) => boolean;
  readonly allowedRendererHttpOrigin?: string | null;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/provider-cloud") return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin === null ? {} : { "access-control-allow-origin": origin }),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin, input.allowedRendererHttpOrigin))
    )
      return new Response(null, { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: input.windowAuthorityStore,
        now: Date.now(),
      });
      if (!principalActsAsHostPerson(context.principal)) {
        return new Response(null, { status: 403 });
      }
      const actor = eventActorForPrincipal(context.principal);
      const caller: ProviderCloudPrincipal =
        context.principal.kind === "local-window"
          ? { kind: "local-window", scopeId: context.scopeId }
          : {
              kind: "person-paired-device",
              scopeId: context.scopeId,
              deviceId: String(context.principal.deviceId),
              sessionId: String(context.principal.sessionId),
              credentialGeneration: context.principal.credentialGeneration,
              actor,
            };
      // The same window id can be registered again while its body or key unlock
      // waits, and a paired device can be revoked, signed out or re-paired.
      // Keep the original admission proof current across body reads and unlocks.
      const admissionCurrent = retainRouteAdmissionCurrent({
        request,
        context,
        store: input.windowAuthorityStore,
        now: Date.now,
      });
      const callerIsCurrent = () => {
        if (!admissionCurrent()) return false;
        if (caller.kind === "person-paired-device") {
          return (
            input.isPersonPairedDeviceCurrent?.(
              caller.deviceId,
              caller.credentialGeneration,
              caller.sessionId,
            ) ?? true
          );
        }
        return true;
      };
      const signal =
        context.abortSignal === undefined
          ? request.signal
          : AbortSignal.any([request.signal, context.abortSignal]);
      const reader = request.body?.getReader();
      if (reader === undefined) return new Response(null, { status: 400 });
      let bytes = 0;
      const parts: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 131_072) return new Response(null, { status: 413 });
          parts.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const command = decodeProviderCloudRequest(JSON.parse(Buffer.concat(parts).toString("utf8")));
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (!callerIsCurrent()) return new Response(null, { status: 403 });
      const result = await input.service.execute(caller, command, signal, callerIsCurrent);
      if (!callerIsCurrent()) return new Response(null, { status: 403 });
      return new Response(JSON.stringify(decodeProviderCloudResponse(result)), {
        status: 200,
        headers,
      });
    } catch {
      return new Response(null, { status: 400, headers });
    }
  };
}
