import { ServerPortForwardCommand, ServerPreviewCommand } from "@octant/contracts/server-projects";
import { Schema } from "effect";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { ServerPreviewTunnels } from "./serverPreviewTunnel";

const PATH = "/api/server-project-preview";
const FORWARD_PATH = "/api/server-project-forward";
export function createServerPreviewTunnelRoutes(dependencies: {
  readonly windows: WindowAuthorityStore;
  readonly tunnels: ServerPreviewTunnels;
  readonly isPersonPairedDeviceCurrent?: (
    deviceId: string,
    credentialGeneration: number,
    sessionId?: string,
  ) => boolean;
  readonly now?: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PATH && url.pathname !== FORWARD_PATH) return undefined;
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
    let localWindow = false;
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
      localWindow = context.principal.kind === "local-window";
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
    const windowStillCurrent = () => {
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
    };
    if (url.pathname === FORWARD_PATH) {
      // A forward listens on this computer's 127.0.0.1, not the device's. A
      // paired device's preview goes through the relay instead, and no relay
      // carries a server Project's raw TCP to a device.
      if (!localWindow)
        return json({ error: "Only a window on this computer can forward a port." }, 403);
      await dependencies.tunnels.reconcile();
      if (request.method === "GET")
        return json({
          view:
            dependencies.tunnels.readForward(url.searchParams.get("projectId") ?? "", owner) ??
            null,
        });
      let forward: typeof ServerPortForwardCommand.Type;
      try {
        forward = Schema.decodeUnknownSync(ServerPortForwardCommand)(body);
      } catch {
        return json({ error: "Invalid forward command." }, 400);
      }
      const result =
        forward.kind === "start"
          ? await dependencies.tunnels.startForward(
              String(forward.projectId),
              owner,
              forward.remotePort,
              windowStillCurrent,
            )
          : await dependencies.tunnels.stopForward(String(forward.projectId), owner);
      return json(result, result.kind === "refused" ? 409 : 200);
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
              windowStillCurrent,
            )
        : command.kind === "stop"
          ? await dependencies.tunnels.stop(String(command.projectId), owner)
          : await dependencies.tunnels.reconnect(String(command.projectId), owner);
    return json(result, result.kind === "refused" ? 409 : 200);
  };
}
