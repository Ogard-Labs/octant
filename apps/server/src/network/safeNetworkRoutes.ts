import {
  decodeSafeNetworksCommand,
  type SafeNetworksCommand,
  type SafeNetworksCommandResult,
  type SafeNetworksRefusalReason,
  type SafeNetworksView,
} from "@octant/contracts/safe-networks";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderRuntimeNetwork } from "./providerRuntimeNetwork";
import type {
  SafeNetworkPrincipal,
  SafeNetworkStore,
  SafeNetworksChange,
} from "./safeNetworkStore";

const ROUTE = "/api/access/safe-networks";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface SafeNetworkRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<
    SafeNetworkStore,
    "account" | "projectOverride" | "set" | "clearProject" | "limitsOn" | "setLimits"
  >;
  readonly network: Pick<ProviderRuntimeNetwork, "refusals" | "enforced">;
  /** Whether a Project with this id exists on this host. */
  readonly projectExists: (projectId: string) => boolean;
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
 * Settings › Access › Safe networks: the account default, a Project's
 * override, and the hosts its runtimes were recently refused. The principal
 * comes from the authenticated request; only a person at a local window
 * changes what is trusted.
 */
export function createSafeNetworkRouteHandler(dependencies: SafeNetworkRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Safe network requests must use loopback.", 400, null);
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
        return failure("Safe network body must be valid JSON.", 400, origin);
      }
    }
    let principal: SafeNetworkPrincipal;
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
        return failure("Safe network request is unauthorized.", 401, origin);
      }
      return failure("Safe network request is invalid.", 400, origin);
    }

    if (request.method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      if (projectId !== undefined && !dependencies.projectExists(projectId)) {
        return json(refused("project-not-found"), 404, origin);
      }
      return json({ view: view(dependencies, projectId) }, 200, origin);
    }
    let command: SafeNetworksCommand;
    try {
      command = decodeSafeNetworksCommand(body);
    } catch {
      return failure("Safe network command is invalid.", 400, origin);
    }
    const change: SafeNetworksChange =
      command.kind === "set-limits"
        ? dependencies.store.setLimits({ enabled: command.enabled, principal })
        : command.kind === "set-places"
          ? dependencies.store.set({ scope: command.scope, places: command.places, principal })
          : dependencies.store.clearProject({ projectId: String(command.projectId), principal });
    const projectId =
      command.kind === "clear-project-override"
        ? String(command.projectId)
        : command.kind === "set-places" && command.scope.kind === "project"
          ? String(command.scope.projectId)
          : (url.searchParams.get("projectId") ?? undefined);
    const result: SafeNetworksCommandResult =
      change.kind === "changed"
        ? { kind: "safe-networks-updated", view: view(dependencies, projectId) }
        : refused(change.reason, change.placeIndex);
    return json(result, result.kind === "safe-networks-updated" ? 200 : 409, origin);
  };
}

function view(
  dependencies: SafeNetworkRouteDependencies,
  projectId: string | undefined,
): SafeNetworksView {
  const known = projectId !== undefined && dependencies.projectExists(projectId);
  return {
    account: dependencies.store.account(),
    ...(known
      ? {
          project: {
            projectId: projectId as NonNullable<SafeNetworksView["project"]>["projectId"],
            override: dependencies.store.projectOverride(projectId),
          },
        }
      : {}),
    refused: dependencies.network.refusals(known ? projectId : undefined),
    enforced: dependencies.network.enforced,
    limitsOn: dependencies.store.limitsOn(),
  };
}

const MESSAGES: Readonly<Record<SafeNetworksRefusalReason, string>> = {
  "needs-local-window": "Safe networks can be changed only at this computer.",
  "invalid-place":
    "That is not a place Octant can trust. Use a name such as git.example.com, a domain such as example.com, or a range such as 192.168.1.0/24.",
  "covers-link-local":
    "That range reaches link-local addresses, where cloud metadata answers, so it cannot be trusted.",
  "project-not-found": "That Project is not on this computer.",
  unavailable: "The change could not be recorded, so nothing changed.",
};

function refused(
  reason: SafeNetworksRefusalReason,
  placeIndex?: number,
): SafeNetworksCommandResult {
  return {
    kind: "safe-networks-refused",
    reason,
    message: MESSAGES[reason],
    ...(placeIndex === undefined ? {} : { placeIndex }),
  };
}
