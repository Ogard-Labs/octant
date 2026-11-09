import { Schema } from "effect";
import { RemoteSetupCheckInput } from "@octant/contracts/remote-setup";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { RemoteSetupChecks } from "./remoteSetupChecks";

export function createRemoteSetupCheckRoutes(dependencies: {
  readonly windows: WindowAuthorityStore;
  readonly checks: Pick<RemoteSetupChecks, "check">;
  readonly now?: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/remote-setup-check") return undefined;
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": request.headers.get("origin") ?? "",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!isLoopbackHostname(url.hostname)) return json({ error: "Loopback required." }, 400);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    let owner: string;
    let signal = request.signal;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windows,
        now: (dependencies.now ?? Date.now)(),
        body,
      });
      if (context.principal.kind !== "local-window")
        return json({ status: "stopped", reason: "needs-local-window" });
      owner = String(context.scopeId);
      if (context.abortSignal !== undefined)
        signal = AbortSignal.any([signal, context.abortSignal]);
    } catch {
      return json({ error: "Setup check is unauthorized." }, 401);
    }
    let input: typeof RemoteSetupCheckInput.Type;
    try {
      input = Schema.decodeUnknownSync(RemoteSetupCheckInput)(body);
    } catch {
      return json({ error: "Invalid setup check." }, 400);
    }
    const result = await dependencies.checks.check(input, signal);
    // A late result cannot lend a departed window's admission to another caller.
    if (
      !dependencies.windows
        .listWindowIds((dependencies.now ?? Date.now)())
        .some((id) => String(id) === owner)
    )
      return json({ error: "Setup check window closed." }, 401);
    return json(result);
  };
}
