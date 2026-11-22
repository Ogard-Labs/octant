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
import type { MemberUpkeepService } from "./memberUpkeep";

export const MEMBER_INSTALL_PATH = "/api/shield/servers/member-install";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;

export interface MemberInstallRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<
    MemberInstallService,
    "prepare" | "confirm" | "progress" | "downloadProgress" | "leaveDownload"
  >;
  readonly upkeep: Pick<
    MemberUpkeepService,
    | "members"
    | "prepareUpdate"
    | "confirmUpdate"
    | "updateProgress"
    | "prepareRemoval"
    | "confirmRemoval"
    | "removalProgress"
  >;
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

/** What the person asked for, decided by the install or the upkeep service. */
async function answer(
  dependencies: MemberInstallRouteDependencies,
  command: MemberInstallCommand,
  requester: MemberInstallRequester,
  signal: AbortSignal,
): Promise<MemberInstallResult> {
  const { service, upkeep } = dependencies;
  switch (command.kind) {
    case "prepare-member-install":
      return await service.prepare(String(command.serverId), requester, signal);
    case "confirm-member-install":
      return await service.confirm(
        { planId: String(command.planId), listenAddress: command.listenAddress },
        requester,
      );
    case "read-member-install":
      return service.progress(String(command.installId), requester);
    case "list-member-computers":
      return upkeep.members(requester);
    case "prepare-member-update":
      return await upkeep.prepareUpdate(String(command.serverId), requester, signal);
    case "confirm-member-update":
      return await upkeep.confirmUpdate(
        { planId: String(command.planId), drain: command.drain },
        requester,
      );
    case "read-member-update":
      return upkeep.updateProgress(String(command.updateId), requester);
    case "prepare-member-removal":
      return await upkeep.prepareRemoval(String(command.serverId), requester);
    case "confirm-member-removal":
      return upkeep.confirmRemoval(
        { planId: String(command.planId), deleteData: command.deleteData },
        requester,
      );
    case "read-member-removal":
      return upkeep.removalProgress(String(command.removalId), requester);
    case "read-member-build-download":
      return service.downloadProgress(String(command.downloadId), requester);
    case "leave-member-build-download":
      return service.leaveDownload(String(command.downloadId), requester);
  }
}

/**
 * Settings › Servers › Make this an Octant computer, Update, and Remove
 * Octant. The route resolves the principal from the authenticated request;
 * the services decide.
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
    const result = await answer(dependencies, command, requester, request.signal);
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
