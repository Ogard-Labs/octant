import { decodeSandboxRestrictionsCommand } from "@octant/contracts/sandbox-policy";
import { decodeProjectId } from "@octant/contracts";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { SandboxRestrictionsService } from "./sandboxRestrictionsService";

export function createSandboxRestrictionsRoutes(dependencies: {
  readonly service: Pick<SandboxRestrictionsService, "snapshot" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/sandbox-restrictions" &&
      url.pathname !== "/api/sandbox-restrictions/commands"
    )
      return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": origin ?? "",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!isLoopbackHostname(url.hostname))
      return json({ error: "Sandbox settings require this host's loopback connection." }, 400);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: Date.now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) return json({ error: error.message }, 401);
      throw error;
    }
    if (!principalActsAsHostPerson(principal))
      return json(
        {
          kind: "sandbox-restrictions-refused",
          reason: "unauthorized",
          message: "Only the person on this host can change sandbox grants.",
        },
        403,
      );
    try {
      if (request.method === "GET" && url.pathname === "/api/sandbox-restrictions") {
        const threadId = url.searchParams.get("threadId");
        const projectId = url.searchParams.get("projectId");
        if (
          threadId !== null &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId)
        )
          return json({ error: "Invalid thread." }, 400);
        return json(
          dependencies.service.snapshot(
            threadId !== null
              ? { kind: "session", threadId }
              : projectId !== null
                ? { kind: "project", projectId: decodeProjectId(projectId) }
                : {
                    kind: "settings",
                    mode: url.searchParams.get("mode") === "work" ? "work" : "code",
                  },
          ),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/sandbox-restrictions/commands") {
        const body = await request.text();
        if (body.length > 131_072)
          return json({ error: "Sandbox settings request is too large." }, 413);
        const command = decodeSandboxRestrictionsCommand(JSON.parse(body) as unknown);
        const result = dependencies.service.change(command, eventActorForPrincipal(principal));
        return json(result, result.kind === "sandbox-restrictions-refused" ? 409 : 200);
      }
    } catch {
      return json(
        {
          kind: "sandbox-restrictions-refused",
          reason: "malformed",
          message: "Review the sandbox settings and try again.",
        },
        400,
      );
    }
    return json({ error: "Sandbox settings route not found." }, 404);
  };
}
