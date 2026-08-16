import {
  decodeUpdateAutomationNotificationPreferences,
  type AutomationNotificationDeliveryQueryResponse,
  type AutomationNotificationDeliveryStatus,
  type AutomationNotificationPreferences,
} from "@octant/contracts";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AutomationNotificationPreferencesStoreError,
  type AutomationNotificationPreferencesStore,
} from "./automationNotificationPreferencesStore";
import type { AutomationNotificationDeliveryService } from "./automationNotificationDeliveryService";

const METHODS = "GET, PUT, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface AutomationNotificationRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly preferences: Pick<AutomationNotificationPreferencesStore, "current" | "update">;
  readonly delivery: Pick<AutomationNotificationDeliveryService, "status" | "queryDeliveries">;
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

function authorizeRequest(
  request: Request,
  dependencies: AutomationNotificationRouteDependencies,
  now: () => number,
): { readonly kind: "local-window" | "remote-device" } | Response {
  const bound = readPrincipalRouteContext(request);
  if (bound !== undefined) {
    return {
      kind: bound.principal.kind === "remote-device" ? "remote-device" : "local-window",
    };
  }
  try {
    authenticateRouteWindowId({
      request,
      store: dependencies.windowAuthorityStore,
      now: now(),
    });
    return { kind: "local-window" };
  } catch (error) {
    const origin = request.headers.get("origin");
    if (error instanceof WindowAuthorityError) {
      return failure("Automation notification request is unauthorized.", 401, origin);
    }
    return failure("Automation notification request is invalid.", 400, origin);
  }
}

/**
 * Authenticated Automation notification preference + honest delivery status
 * routes. Status never includes tokens, provider credentials, or host-only
 * secrets — only enabled/unavailable facts safe for local and remote clients.
 * Preference mutation stays local-window authority. Delivery queries are
 * host/Project-scoped opaque receipts for Center and settings.
 */
export function createAutomationNotificationRouteHandler(
  dependencies: AutomationNotificationRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/automation-notifications" &&
      url.pathname !== "/api/automation-notifications/status" &&
      url.pathname !== "/api/automation-notifications/deliveries"
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Automation notification requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const auth = authorizeRequest(request, dependencies, now);
    if (auth instanceof Response) return auth;

    if (url.pathname === "/api/automation-notifications/status" && request.method === "GET") {
      const status: AutomationNotificationDeliveryStatus = dependencies.delivery.status();
      return json({ status }, 200, origin);
    }

    if (url.pathname === "/api/automation-notifications/deliveries" && request.method === "GET") {
      const query: AutomationNotificationDeliveryQueryResponse =
        dependencies.delivery.queryDeliveries({
          ...(url.searchParams.get("automationId") === null
            ? {}
            : { automationId: url.searchParams.get("automationId")! }),
          ...(url.searchParams.get("runId") === null
            ? {}
            : { runId: url.searchParams.get("runId")! }),
          ...(url.searchParams.get("projectId") === null
            ? {}
            : { projectId: url.searchParams.get("projectId")! }),
        });
      return json(query, 200, origin);
    }

    if (url.pathname === "/api/automation-notifications" && request.method === "GET") {
      const preferences: AutomationNotificationPreferences = dependencies.preferences.current();
      return json({ preferences }, 200, origin);
    }

    if (url.pathname === "/api/automation-notifications" && request.method === "PUT") {
      if (auth.kind !== "local-window") {
        return failure(
          "Automation notification preferences can only be updated from the local host.",
          403,
          origin,
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("Automation notification preferences body must be valid JSON.", 400, origin);
      }
      let command: ReturnType<typeof decodeUpdateAutomationNotificationPreferences>;
      try {
        command = decodeUpdateAutomationNotificationPreferences(body);
      } catch {
        return failure("Automation notification preferences body is invalid.", 400, origin);
      }
      try {
        const preferences = dependencies.preferences.update(command);
        return json({ preferences }, 200, origin);
      } catch (error) {
        if (error instanceof AutomationNotificationPreferencesStoreError) {
          if (error.category === "conflict") {
            return failure(
              "Automation notification preferences changed concurrently.",
              409,
              origin,
            );
          }
          return failure(error.message, 400, origin);
        }
        throw error;
      }
    }

    return failure("Automation notification method is not allowed.", 405, origin);
  };
}
