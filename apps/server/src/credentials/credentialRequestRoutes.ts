import { Schema } from "effect";
import { CredentialRequestAnswer } from "@octant/contracts/credential-request";
import { resolvePrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { CredentialRequests } from "./credentialRequests";

export function createCredentialRequestRoutes(
  service: CredentialRequests,
  store: WindowAuthorityStore,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/credential-requests") return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin !== null && isAllowedRendererOrigin(origin)
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {}),
    };
    const reply = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers });
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin)))
      return reply({ status: "refused" }, 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-octant-window-capability",
        },
      });
    let context;
    try {
      context = resolvePrincipalRouteContext({ request, store, now: Date.now() });
    } catch {
      return reply({ status: "refused" }, 401);
    }
    if (context.principal.kind !== "local-window") return reply({ status: "refused" }, 403);
    if (request.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      if (
        !threadId ||
        threadId.length > 256 ||
        [...url.searchParams.keys()].some((key) => key !== "threadId")
      )
        return reply({ status: "invalid" }, 400);
      return reply(service.view(String(context.scopeId), threadId));
    }
    if (
      request.method !== "POST" ||
      url.search ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return reply({ status: "invalid" }, 400);
    // Bound the stream, not just Content-Length, before parsing private input.
    const reader = request.body?.getReader();
    if (reader === undefined) return reply({ status: "invalid" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) return reply({ status: "invalid" }, 413);
        chunks.push(part.value);
      }
      const answer = Schema.decodeUnknownSync(CredentialRequestAnswer)(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      // Reauthenticate after reading the body. It may have arrived slowly.
      const current = resolvePrincipalRouteContext({ request, store, now: Date.now() });
      if (
        current.principal.kind !== "local-window" ||
        String(current.scopeId) !== String(context.scopeId)
      )
        return reply({ status: "refused" }, 403);
      return reply({
        status: (await service.answer(String(context.scopeId), answer)) ? "accepted" : "refused",
      });
    } catch {
      return reply({ status: "invalid" }, 400);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
}
