import {
  decodeMemberInstallCommand,
  type MemberInstallCommand,
  type MemberInstallResult,
} from "@octant/contracts/shield-servers";
import {
  isAgentGrantSession,
  principalActsAsHostPerson,
  type ClientPrincipal,
} from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { MemberInstallRequester, MemberInstallService } from "./memberInstall";

export const MEMBER_INSTALL_PATH = "/api/shield/servers/member-install";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;

export interface MemberInstallRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<MemberInstallService, "prepare" | "confirm" | "progress">;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

/**
 * Who a request comes from, as the install judges it: the host's own person
 * at a window or on a device they paired, journaled as that window's person
 * or that device, or someone the install refuses.
 */
function memberInstallRequesterFor(principal: ClientPrincipal): MemberInstallRequester {
  if (isAgentGrantSession(principal)) return { kind: "agent-grant" };
  return principalActsAsHostPerson(principal)
    ? { kind: "person", actor: eventActorForPrincipal(principal) }
    : { kind: "restricted-device" };
}

/**
 * Settings › Servers › Make this an Octant computer. The route resolves the
 * principal from the authenticated request; the service decides.
 */
export function createMemberInstallRouteHandler(dependencies: MemberInstallRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== MEMBER_INSTALL_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Server requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > BODY_LIMIT) {
      return json({ error: "Request body is too large." }, 413, origin);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ error: "Server body must be valid JSON." }, 400, origin);
    }
    let requester: MemberInstallRequester;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        body,
      });
      requester = memberInstallRequesterFor(context.principal);
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Server request is unauthorized." }, 401, origin);
      }
      return json({ error: "Server request is invalid." }, 400, origin);
    }
    let command: MemberInstallCommand;
    try {
      command = decodeMemberInstallCommand(body);
    } catch {
      return json({ error: "Server command is invalid." }, 400, origin);
    }
    const result: MemberInstallResult =
      command.kind === "prepare-member-install"
        ? await dependencies.service.prepare(String(command.serverId), requester)
        : command.kind === "confirm-member-install"
          ? await dependencies.service.confirm(
              { planId: String(command.planId), listenAddress: command.listenAddress },
              requester,
            )
          : dependencies.service.progress(String(command.installId), requester);
    return json(
      result,
      result.kind !== "member-install-refused"
        ? 200
        : result.reason === "not-the-person"
          ? 403
          : 409,
      origin,
    );
  };
}
