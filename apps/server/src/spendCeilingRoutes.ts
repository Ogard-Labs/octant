import {
  decodeSpendCeilingCommand,
  decodeSpendCeilingSnapshot,
  decodeSpendCeilingThreadType,
  type SpendCeilingCommand,
  type SpendCeilingCommandResult,
  type WindowId,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import { isLoopbackHostname } from "./shellRoutes";
import type { SpendCeilingService } from "./spendCeilingService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 16_384;
const SNAPSHOT_PATH = "/api/spend-ceilings";
const COMMAND_PATH = "/api/spend-ceilings/commands";

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

export interface SpendCeilingRouteDependencies {
  readonly service: SpendCeilingService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createSpendCeilingRouteHandler(dependencies: SpendCeilingRouteDependencies) {
  const now = dependencies.now ?? Date.now;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/spend-ceilings")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Spend ceiling requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure(error.message, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }

    if (url.pathname === SNAPSHOT_PATH && request.method === "GET") {
      const threadId = url.searchParams.get("threadId") ?? undefined;
      const threadTypeParam = url.searchParams.get("threadType");
      const projectId = url.searchParams.get("projectId") ?? undefined;
      let threadType;
      try {
        threadType =
          threadTypeParam === null ? undefined : decodeSpendCeilingThreadType(threadTypeParam);
      } catch {
        return failure("Thread type is invalid.", 400, origin);
      }
      const snapshot = dependencies.service.snapshot({
        principalKind: principal.kind,
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadType === undefined ? {} : { threadType }),
        ...(projectId === undefined ? {} : { projectId }),
      });
      if ("kind" in snapshot && snapshot.kind === "unauthorized") {
        return failure("Spend ceiling reads are unauthorized.", 403, origin);
      }
      return new Response(JSON.stringify(decodeSpendCeilingSnapshot(snapshot)), {
        status: 200,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (url.pathname === COMMAND_PATH && request.method === "POST") {
      if (principal.kind !== "local-window") {
        return failure(
          "Setting a spend ceiling is a host owner command. Open this host locally to raise or clear it.",
          403,
          origin,
        );
      }
      let body: unknown;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return failure("Request is too large.", 413, origin);
        body = JSON.parse(text) as unknown;
      } catch {
        return failure("Spend ceiling command is invalid.", 400, origin);
      }
      let command: SpendCeilingCommand;
      try {
        command = decodeSpendCeilingCommand(body);
      } catch {
        return failure("Spend ceiling command is invalid.", 400, origin);
      }
      let result: SpendCeilingCommandResult;
      try {
        result = dependencies.service.execute(principal.kind, command);
      } catch (error) {
        if (error instanceof ConcurrencyConflict) {
          return failure("Spend ceiling changed; reload and retry.", 409, origin);
        }
        return failure("Spend ceiling command could not be applied.", 503, origin);
      }
      const status = result.kind === "refused" ? 409 : 200;
      return new Response(JSON.stringify(result), {
        status,
        headers: { "content-type": "application/json", ...corsHeaders(origin) },
      });
    }

    return failure("Spend ceiling route is not found.", 404, origin);
  };
}

export type { WindowId };
