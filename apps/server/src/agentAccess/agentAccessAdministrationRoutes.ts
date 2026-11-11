import { createHash, timingSafeEqual } from "node:crypto";
import { decodeAgentAccessCommand, type AgentAccessResult } from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { AGENT_ACCESS_LOCAL_ACTOR, type AgentAccessService } from "./agentAccessService";

const MAX_BODY_BYTES = 64 * 1_024;
export const AGENT_ACCESS_ADMINISTRATION_ROUTES = {
  grants: "/api/desktop/agent-access",
  commands: "/api/desktop/agent-access/commands",
} as const;

export interface AgentAccessAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: AgentAccessService;
  /** Stops the turns a revoked grant's threads are running, when the person asks. */
  readonly stopRunningTurns: (grantId: string) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Settings › Agent access and `octant agent-access`: list, create, change, and
 * revoke agent grants, issue connection codes, confirm keys, and rotate bearer
 * keys. Like device administration, these answer only over loopback with the
 * desktop bridge secret and a registered window capability, and the private
 * listener forwards none of them (`/api/desktop` is local-only).
 */
export function createAgentAccessAdministrationRouteHandler(
  options: AgentAccessAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname !== AGENT_ACCESS_ADMINISTRATION_ROUTES.grants &&
      url.pathname !== AGENT_ACCESS_ADMINISTRATION_ROUTES.commands
    ) {
      return undefined;
    }
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", 401);
    }
    if (url.search !== "") return failure("invalid", 400);
    try {
      options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    if (url.pathname === AGENT_ACCESS_ADMINISTRATION_ROUTES.grants) {
      if (request.method !== "GET") return failure("invalid", 405);
      return answer({ kind: "grants", grants: options.service.list() });
    }
    if (request.method !== "POST") return failure("invalid", 405);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 415);
    }
    const text = await request.text().catch(() => undefined);
    if (text === undefined || text.length > MAX_BODY_BYTES) return failure("invalid", 413);
    let command;
    try {
      command = decodeAgentAccessCommand(JSON.parse(text));
    } catch {
      return answer({
        kind: "refused",
        reason: "invalid",
        message: "That agent access command is not valid.",
      });
    }
    const result = options.service.execute(command, AGENT_ACCESS_LOCAL_ACTOR);
    if (command.kind === "revoke" && command.stopRunningTurns && result.kind === "done") {
      await options.stopRunningTurns(String(command.grantId)).catch(() => undefined);
    }
    return answer(result);
  };
}

function answer(result: AgentAccessResult): Response {
  return Response.json(result, {
    status: result.kind === "refused" ? 409 : 200,
    headers: { "cache-control": "no-store" },
  });
}

function failure(category: "unavailable" | "unauthorized" | "invalid", status: number): Response {
  return Response.json(
    { category, message: "Agent access administration refused this request." },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function secretsEqual(expected: string, offered: string): boolean {
  const left = createHash("sha256").update(expected).digest();
  const right = createHash("sha256").update(offered).digest();
  return timingSafeEqual(left, right) && expected.length > 0;
}
