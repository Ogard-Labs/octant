import {
  decodeCommandCredentialCommand,
  type CommandCredentialResult,
} from "@octant/contracts/command-credentials";
import { resolvePrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { CommandCredentialBindings } from "./commandCredentialBindings";

export function commandCredentialRoutes(
  service: CommandCredentialBindings,
  store: WindowAuthorityStore,
  allowedOrigin?: string | null,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/secret-stores/command-bindings") return undefined;
    const origin = request.headers.get("origin");
    const allowed = origin !== null && isAllowedRendererOrigin(origin, allowedOrigin);
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(allowed ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    };
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    const refusal = (
      reason: "unauthorized" | "invalid" | "unavailable",
      message: string,
    ): CommandCredentialResult => ({ kind: "command-credential-refused", reason, message });
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !allowed))
      return reply(refusal("unauthorized", "Credential commands are local-window only."), 403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-octant-window-capability",
        },
      });
    const authenticate = () => {
      const context = resolvePrincipalRouteContext({ request, store, now: Date.now() });
      if (context.principal.kind !== "local-window") throw Error("Local window required");
      return String(context.scopeId);
    };
    let windowId: string;
    try {
      windowId = authenticate();
    } catch {
      return reply(refusal("unauthorized", "A current local window is required."), 401);
    }
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some((key) => key !== "projectId" && key !== "threadId"))
        return reply(refusal("invalid", "Invalid view scope."), 400);
      return reply(
        service.view(
          windowId,
          url.searchParams.get("projectId") ?? undefined,
          url.searchParams.get("threadId") ?? undefined,
        ),
      );
    }
    if (
      request.method !== "POST" ||
      url.search ||
      request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    )
      return reply(refusal("invalid", "Invalid command."), 400);
    const reader = request.body?.getReader();
    if (reader === undefined) return reply(refusal("invalid", "A command is required."), 400);
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16384) return reply(refusal("invalid", "Command exceeds the input bound."), 413);
        chunks.push(next.value);
      }
      const command = decodeCommandCredentialCommand(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (authenticate() !== windowId)
        return reply(refusal("unauthorized", "Window authority changed."), 403);
      switch (command.kind) {
        case "save":
          return reply(
            await service.save(
              windowId,
              command.definition,
              command.bindingId,
              command.expectedRevision,
            ),
          );
        case "remove":
          return reply(service.remove(windowId, command.bindingId, command.expectedRevision));
        case "review":
          return reply(
            await service.review(
              windowId,
              command.threadId,
              command.bindingId,
              command.operationId,
            ),
          );
        case "approve":
          return reply(await service.approve(windowId, command.requestId));
        case "deny":
          return reply(service.cancel(windowId, command.requestId, true));
        case "cancel":
          return reply(service.cancel(windowId, command.requestId));
      }
    } catch {
      return reply(refusal("invalid", "The command could not be accepted."), 400);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
}
