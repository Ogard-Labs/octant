import {
  decodeDiagnosticsExportRequest,
  type DiagnosticHostHealth,
  type DiagnosticsExportOutcome,
} from "@octant/contracts";
import { authorizeDiagnosticsExportActor, type DiagnosticsExportActorKind } from "@octant/domain";
import { resolveReportedHostVersion } from "@octant/host-runtime";
import { isLoopbackHostname } from "./shellRoutes";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { authenticateRoutePrincipal, type PrincipalRouteContext } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { exportDiagnosticsEvidence } from "./diagnosticsExportService";
import { readEventLoopLagCounters } from "./eventLoopLag";
import { slowStatementTally } from "./persistence/slowStatementLog";
import { readJournalGrowth } from "./persistence/journalGrowth";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";

/**
 * The one browser-first HTTP entry point for the authenticated
 * diagnostics export command. Mirrors `./usageRoutes.ts` — loopback
 * only after the remote gateway hands the request over, an allow-listed
 * renderer origin, and the bound principal as the gate. A local window and a
 * device the host's own person paired act as that person (maintainer
 * decision, 2026-11-12); a restricted or hub-introduced device, an agent
 * grant, a provider process, an automation/agent run, or an extension all
 * fail closed before `exportDiagnosticsEvidence` (and therefore the
 * redaction/sealing policy) is ever reached.
 */

/**
 * Who a diagnostics request comes from, judged from the principal the server
 * bound to it, and the actor its journal record names: the local person, or
 * the paired device by its own id.
 */
export function diagnosticsExportCaller(context: PrincipalRouteContext): {
  readonly actorKind: DiagnosticsExportActorKind;
  readonly actor: ReturnType<typeof eventActorForPrincipal>;
} {
  const { principal } = context;
  return {
    actorKind:
      principal.kind === "local-window"
        ? "local-window"
        : principalActsAsHostPerson(principal)
          ? "person-paired-device"
          : "remote-device",
    actor: eventActorForPrincipal(principal),
  };
}

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 8_192;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ error: message }, status, origin);
}

function readHostHealth(): DiagnosticHostHealth {
  const statements = slowStatementTally.read();
  const lag = readEventLoopLagCounters();
  return {
    slowStatementCount: statements.count,
    slowStatementWorstMs: statements.worstMs,
    eventLoopLagCount: lag.count,
    eventLoopLagWorstMs: lag.worstMs,
  };
}

export interface DiagnosticsExportRouteDependencies {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly octantVersion?: string;
  readonly now?: () => number;
  readonly clock?: () => string;
}

export function createDiagnosticsExportRouteHandler(
  dependencies: DiagnosticsExportRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const clock = dependencies.clock ?? (() => new Date().toISOString());

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isGrowthRead = url.pathname === "/api/diagnostics/journal-growth";
    if (url.pathname !== "/api/diagnostics/export" && !isGrowthRead) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Diagnostics export requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== (isGrowthRead ? "GET" : "POST")) {
      return failureResponse(
        isGrowthRead ? "Journal growth requires GET." : "Diagnostics export requires POST.",
        405,
        origin,
      );
    }

    let caller: ReturnType<typeof diagnosticsExportCaller>;
    try {
      caller = diagnosticsExportCaller(
        authenticateRoutePrincipal({
          request,
          store: dependencies.windowAuthorityStore,
          now: now(),
        }),
      );
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Diagnostics export is unauthorized.", 401, origin);
      }
      return failureResponse("Diagnostics export request is invalid.", 400, origin);
    }

    // The bound principal is the only actor this route may name. Hardcoding
    // local-window here would export host-wide evidence for a remote device
    // that reached the loopback handler through product dispatch.
    const authorization = authorizeDiagnosticsExportActor(caller.actorKind);
    if (authorization.kind === "denied") {
      return failureResponse("Diagnostics export is unauthorized.", 403, origin);
    }

    if (isGrowthRead) {
      // Read on demand when diagnostics open, never on a timer.
      try {
        return jsonResponse(
          readJournalGrowth(dependencies.connection, new Date(now())),
          200,
          origin,
        );
      } catch {
        return failureResponse("Journal growth could not be read.", 500, origin);
      }
    }

    const decoded = await readJson(request, BODY_LIMIT);
    if (decoded.kind === "too-large") {
      return failureResponse("Request body is too large.", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return failureResponse("Request body must be valid JSON.", 400, origin);
    }

    let exportRequest;
    try {
      exportRequest = decodeDiagnosticsExportRequest(decoded.value);
    } catch {
      return failureResponse("Diagnostics export request is invalid.", 400, origin);
    }

    const outcome: DiagnosticsExportOutcome = exportDiagnosticsEvidence(exportRequest, {
      connection: dependencies.connection,
      journal: dependencies.journal,
      octantVersion: dependencies.octantVersion ?? resolveReportedHostVersion(process.env),
      hostHealth: readHostHealth,
      clock,
      actor: caller.actor,
    });

    return jsonResponse(outcome, outcome.kind === "exported" ? 200 : 422, origin);
  };
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" };

async function readJson(request: Request, limit: number): Promise<ReadJsonResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    return { kind: "too-large" };
  }
  try {
    const text = await request.text();
    if (text.length > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}
