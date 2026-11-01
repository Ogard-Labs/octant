import {
  decodeShieldServersCommand,
  type ShieldServersCommand,
  type ShieldServersCommandResult,
  type ShieldServersRefusalReason,
  type ShieldServersView,
} from "@octant/contracts/shield-servers";
import { AggregateId } from "@octant/contracts";
import { Schema } from "effect";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ShieldServerPrincipal,
  ShieldServerStore,
  ShieldServersChange,
} from "./shieldServerStore";
import type { ServerSshKeys } from "./sshKeyBrokerClient";

const ROUTE = "/api/shield/servers";
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ShieldServerRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<
    ShieldServerStore,
    | "servers"
    | "register"
    | "change"
    | "remove"
    | "projectOverride"
    | "setProjectServers"
    | "clearProject"
    | "serverById"
  >;
  /** The keys Octant keeps for servers that sign in with one; absent without a credential broker. */
  readonly sshKeys?: Pick<ServerSshKeys, "ensure">;
  readonly projectExists: (projectId: string) => boolean;
  /** Whether the person's SSH agent socket is there for SSH sessions to use. */
  readonly sshAgentAvailable: () => boolean;
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

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/**
 * Settings › Servers: the servers a person registered with Octant Shield.
 * The principal comes from the authenticated request; only a person at a
 * local window changes the registry.
 */
export function createShieldServerRouteHandler(dependencies: ShieldServerRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Server requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return failure("Method not allowed.", 405, origin);
    }
    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return failure("Server body must be valid JSON.", 400, origin);
      }
    }
    let principal: ShieldServerPrincipal;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(body === undefined ? {} : { body }),
      });
      principal = context.principal.kind === "remote-device" ? "remote-device" : "local-window";
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Server request is unauthorized.", 401, origin);
      }
      return failure("Server request is invalid.", 400, origin);
    }

    if (request.method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      if (projectId !== undefined && !dependencies.projectExists(projectId)) {
        return json(refused("project-not-found"), 404, origin);
      }
      return json({ view: view(dependencies, projectId) }, 200, origin);
    }
    let command: ShieldServersCommand;
    try {
      command = decodeShieldServersCommand(body);
    } catch {
      return failure("Server command is invalid.", 400, origin);
    }
    if (
      (command.kind === "set-project-servers" || command.kind === "clear-project-override") &&
      !dependencies.projectExists(String(command.projectId))
    ) {
      return json(refused("project-not-found"), 404, origin);
    }
    if (command.kind === "show-server-key") {
      const shown = await showServerKey(dependencies, String(command.serverId), principal);
      return json(shown, shown.kind === "shield-server-key" ? 200 : 409, origin);
    }
    const change: ShieldServersChange =
      command.kind === "set-project-servers"
        ? dependencies.store.setProjectServers({
            projectId: String(command.projectId),
            servers: command.servers,
            principal,
          })
        : command.kind === "clear-project-override"
          ? dependencies.store.clearProject({ projectId: String(command.projectId), principal })
          : command.kind === "register-server"
            ? dependencies.store.register({ server: command.server, principal })
            : command.kind === "change-server"
              ? dependencies.store.change({
                  serverId: String(command.serverId),
                  server: command.server,
                  principal,
                })
              : dependencies.store.remove({ serverId: String(command.serverId), principal });
    const projectId =
      command.kind === "set-project-servers" || command.kind === "clear-project-override"
        ? String(command.projectId)
        : (url.searchParams.get("projectId") ?? undefined);
    const known = projectId !== undefined && dependencies.projectExists(projectId);
    const result: ShieldServersCommandResult =
      change.kind === "changed"
        ? {
            kind: "shield-servers-updated",
            view: view(dependencies, known ? projectId : undefined),
          }
        : refused(change.reason);
    return json(result, result.kind === "shield-servers-updated" ? 200 : 409, origin);
  };
}

/**
 * A key is made only for a person at this computer, and only for a server
 * they registered to sign in with one, so a paired device cannot mint keys.
 */
async function showServerKey(
  dependencies: ShieldServerRouteDependencies,
  serverId: string,
  principal: ShieldServerPrincipal,
): Promise<ShieldServersCommandResult> {
  if (principal !== "local-window") return refused("needs-local-window");
  const server = dependencies.store.serverById(serverId);
  if (server === undefined) return refused("server-not-found");
  if (server.signIn !== "octant-key") return refused("signs-in-with-agent");
  const publicKey = await dependencies.sshKeys?.ensure(serverId);
  if (publicKey === undefined) return refused("key-unavailable");
  return { kind: "shield-server-key", serverId: server.serverId, publicKey };
}

function view(
  dependencies: ShieldServerRouteDependencies,
  projectId: string | undefined,
): ShieldServersView {
  return {
    servers: dependencies.store.servers(),
    ...(projectId === undefined
      ? {}
      : {
          project: {
            projectId: decodeAggregateId(projectId),
            override: dependencies.store.projectOverride(projectId) ?? null,
          },
        }),
    sshAgent: dependencies.sshAgentAvailable() ? "available" : "missing",
  };
}

const MESSAGES: Readonly<Record<ShieldServersRefusalReason, string>> = {
  "needs-local-window": "Servers can be changed only at this computer.",
  "duplicate-alias": "A server with that alias is already registered.",
  "invalid-runbook-path":
    "That runbook is in a folder that holds keys or credentials, so Octant will not read it.",
  "invalid-deploy-command": "Write each deploy command on one line.",
  "server-not-found": "That server is not registered.",
  "too-many-servers": "No more servers can be registered.",
  "project-not-found": "That Project does not exist on this computer.",
  "signs-in-with-agent": "That server signs in with your SSH agent, so it has no key here.",
  "key-unavailable": "Octant could not reach its key store, so no key was made.",
  unavailable: "The change could not be recorded, so nothing changed.",
};

function refused(reason: ShieldServersRefusalReason): ShieldServersCommandResult {
  return { kind: "shield-servers-refused", reason, message: MESSAGES[reason] };
}
