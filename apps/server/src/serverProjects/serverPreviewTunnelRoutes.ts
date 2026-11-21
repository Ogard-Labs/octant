import { ServerPreviewCommand } from "@octant/contracts/server-projects";
import { Schema } from "effect";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ServerPreviewTunnels } from "./serverPreviewTunnel";
import type { ServerProjectListenerRead } from "./serverProjectListeners";

const PATH = "/api/server-project-preview";
/** What the login serves from a Project's folder, read on the server so a preview can be picked. */
const LISTENERS_PATH = "/api/server-project-listeners";
export function createServerPreviewTunnelRoutes(dependencies: {
  readonly windows: WindowAuthorityStore;
  readonly tunnels: ServerPreviewTunnels;
  readonly listeners?: (projectId: string) => Promise<ServerProjectListenerRead>;
  readonly isPersonPairedDeviceCurrent?: (
    deviceId: string,
    credentialGeneration: number,
    sessionId?: string,
  ) => boolean;
  readonly now?: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PATH && url.pathname !== LISTENERS_PATH) return undefined;
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": request.headers.get("origin") ?? "",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-octant-window-capability",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!isLoopbackHostname(url.hostname)) return json({ error: "Loopback required." }, 400);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET" && request.method !== "POST")
      return json({ error: "Method not allowed." }, 405);
    let body: unknown;
    try {
      if (request.method === "POST") body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    let owner: string;
    let pairedDevice:
      | {
          readonly deviceId: string;
          readonly credentialGeneration: number;
          readonly sessionId: string;
          readonly actor: ReturnType<typeof eventActorForPrincipal>;
        }
      | undefined;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windows,
        now: (dependencies.now ?? Date.now)(),
        ...(body === undefined ? {} : { body }),
      });
      if (!principalActsAsHostPerson(context.principal))
        return json({ error: "Only this host's own person can control this preview." }, 403);
      owner = String(context.scopeId);
      if (context.principal.kind === "remote-device") {
        pairedDevice = {
          deviceId: String(context.principal.deviceId),
          credentialGeneration: context.principal.credentialGeneration,
          sessionId: String(context.principal.sessionId),
          actor: eventActorForPrincipal(context.principal),
        };
      }
    } catch {
      return json({ error: "Preview request is unauthorized." }, 401);
    }
    // Listed for the window that starts the preview, under the same rule.
    if (url.pathname === LISTENERS_PATH) {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      // The remote gateway already keeps this path local; refusing here too
      // keeps a person-paired device out if that routing ever changes.
      if (pairedDevice !== undefined) {
        return json({ error: "Only a window on this computer lists what a server serves." }, 403);
      }
      if (dependencies.listeners === undefined) {
        return json({ status: "unavailable", message: "Listing is unavailable on this host." });
      }
      return json(await dependencies.listeners(url.searchParams.get("projectId") ?? ""));
    }
    await dependencies.tunnels.reconcile();
    if (request.method === "GET")
      return json({
        view: dependencies.tunnels.read(url.searchParams.get("projectId") ?? "", owner) ?? null,
      });
    let command: typeof ServerPreviewCommand.Type;
    try {
      command = Schema.decodeUnknownSync(ServerPreviewCommand)(body);
    } catch {
      return json({ error: "Invalid preview command." }, 400);
    }
    const result =
      command.kind === "start"
        ? pairedDevice !== undefined
          ? await dependencies.tunnels.startRelayed({
              projectId: String(command.projectId),
              owner,
              remotePort: command.remotePort,
              credentialGeneration: pairedDevice.credentialGeneration,
              sessionId: pairedDevice.sessionId,
              actor: pairedDevice.actor,
              ownerCurrent: () =>
                dependencies.isPersonPairedDeviceCurrent?.(
                  pairedDevice.deviceId,
                  pairedDevice.credentialGeneration,
                  pairedDevice.sessionId,
                ) ?? true,
            })
          : await dependencies.tunnels.start(
              String(command.projectId),
              owner,
              command.remotePort,
              command.localPort,
              () => {
                try {
                  return (
                    String(
                      dependencies.windows.authenticate(
                        request.headers.get("x-octant-window-capability") ?? "",
                        (dependencies.now ?? Date.now)(),
                      ),
                    ) === owner
                  );
                } catch {
                  return false;
                }
              },
            )
        : command.kind === "stop"
          ? await dependencies.tunnels.stop(String(command.projectId), owner)
          : await dependencies.tunnels.reconnect(String(command.projectId), owner);
    return json(result, result.kind === "refused" ? 409 : 200);
  };
}
