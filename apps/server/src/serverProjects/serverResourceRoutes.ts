import type { HostResourceSnapshot } from "@octant/contracts";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ServerResourceRead } from "./serverResources";

const PATH = "/api/server-projects/resources";

export interface ServerResourceRouteDependencies {
  readonly windows: WindowAuthorityStore;
  /** The reader for a Project's server, or undefined when the Project is not on one. */
  readonly readerFor: (projectId: string) => (() => Promise<ServerResourceRead>) | undefined;
  readonly now?: () => number;
}

/**
 * Load on the server a server Project is bound to, for the Vitals tool.
 * Only a person at a local window may ask: the read runs a command under the
 * person's own SSH identity, which a paired device does not hold. The body is
 * the same snapshot `/api/host/resources` answers.
 */
export function createServerResourceRoutes(dependencies: ServerResourceRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": origin ?? "",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!isLoopbackHostname(url.hostname)) return json({ error: "Loopback required." }, 400);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windows,
        now: (dependencies.now ?? Date.now)(),
      });
      if (context.principal.kind !== "local-window") {
        return json({ error: "Server resources are not available to this client." }, 403);
      }
    } catch {
      return json({ error: "Server resources request is unauthorized." }, 401);
    }
    const read = dependencies.readerFor(url.searchParams.get("projectId") ?? "");
    if (read === undefined) return json({ error: "That Project is not on a server." }, 404);
    const result = await read();
    if (result.status === "ready") return json(result.snapshot satisfies HostResourceSnapshot);
    if (result.status === "unsupported") {
      return json({ error: "This server does not report load (Linux servers only)." }, 501);
    }
    return json({ error: result.message }, 502);
  };
}
