import {
  decodeNativeHarnessProjectRoutingCommand,
  decodeProjectId,
  decodeUpdateNativeHarnessRoutingSettings,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { NativeHarnessRoutingStore } from "./nativeHarnessRoutingStore";

const METHODS = "GET, PUT, DELETE, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const HOST_PATH = "/api/native-harness/routing";
const PROJECT_PREFIX = "/api/native-harness/routing/projects/";

export interface NativeHarnessRoutingRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<
    NativeHarnessRoutingStore,
    "host" | "projectOverride" | "updateHost" | "applyProjectCommand"
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

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/**
 * Slot routing settings: the host default and per-Project overrides. Reads
 * and writes are window-authenticated and loopback-only, and a stale version
 * is answered with 409 so two editors cannot silently overwrite each other.
 */
export function createNativeHarnessRoutingRouteHandler(
  dependencies: NativeHarnessRoutingRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== HOST_PATH && !url.pathname.startsWith(PROJECT_PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Native harness routing requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    try {
      authenticateRouteWindowId({ request, store: dependencies.windowAuthorityStore, now: now() });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Native harness routing request is unauthorized.", 401, origin);
      }
      return failure("Native harness routing request is invalid.", 400, origin);
    }

    if (url.pathname === HOST_PATH) {
      if (request.method === "GET") {
        return json({ settings: dependencies.store.host() }, 200, origin);
      }
      if (request.method === "PUT") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return failure("Native harness routing body must be valid JSON.", 400, origin);
        }
        let command;
        try {
          command = decodeUpdateNativeHarnessRoutingSettings(body);
        } catch {
          return failure("Native harness routing update is invalid.", 400, origin);
        }
        const result = dependencies.store.updateHost(command);
        return json(result, statusFor(result), origin);
      }
      return failure("Method not allowed.", 405, origin);
    }

    let projectId;
    try {
      projectId = decodeProjectId(url.pathname.slice(PROJECT_PREFIX.length));
    } catch {
      return failure("Native harness routing Project id is invalid.", 400, origin);
    }
    if (request.method === "GET") {
      const override = dependencies.store.projectOverride(projectId);
      return json({ override: override ?? null }, 200, origin);
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      let body: unknown = {};
      if (request.method === "PUT") {
        try {
          body = await request.json();
        } catch {
          return failure("Native harness routing body must be valid JSON.", 400, origin);
        }
      }
      const record = (body ?? {}) as Record<string, unknown>;
      let command;
      try {
        command = decodeNativeHarnessProjectRoutingCommand(
          request.method === "PUT"
            ? {
                kind: "set-project-routing-override",
                projectId,
                configuration: record.configuration,
                expectedVersion: record.expectedVersion,
              }
            : {
                kind: "clear-project-routing-override",
                projectId,
                expectedVersion: Number(
                  url.searchParams.get("expectedVersion") ?? record.expectedVersion,
                ),
              },
        );
      } catch {
        return failure("Native harness routing override is invalid.", 400, origin);
      }
      const result = dependencies.store.applyProjectCommand(command);
      return json(result, statusFor(result), origin);
    }
    return failure("Method not allowed.", 405, origin);
  };
}

function statusFor(result: { readonly kind: string; readonly reason?: string }): number {
  if (result.kind !== "routing-refused") return 200;
  return result.reason === "stale-version" ? 409 : result.reason === "not-authorized" ? 403 : 404;
}
