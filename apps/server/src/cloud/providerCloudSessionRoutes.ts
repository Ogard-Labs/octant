import {
  decodeProviderCloudRequest,
  decodeProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { WINDOW_CAPABILITY_HEADER } from "../clientPrincipal";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderCloudSessionService } from "./providerCloudSessionService";

export function createProviderCloudSessionRoutes(input: {
  readonly service: Pick<ProviderCloudSessionService, "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
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
      const principal = authenticateRoutePrincipal({
        request,
        store: input.windowAuthorityStore,
        now: Date.now(),
      });
      if (principal.principal.kind !== "local-window") return new Response(null, { status: 403 });
      // The same window id can be registered again while its body or key unlock
      // waits. Keep the original capability, not merely a currently live id.
      const capability = request.headers.get(WINDOW_CAPABILITY_HEADER) ?? "";
      const callerIsCurrent = () => {
        try {
          return (
            !request.signal.aborted &&
            String(input.windowAuthorityStore.authenticate(capability, Date.now())) ===
              String(principal.scopeId)
          );
        } catch {
          return false;
        }
      };
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
      const result = await input.service.execute(
        principal.scopeId,
        command,
        request.signal,
        callerIsCurrent,
      );
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
