import { decodeDiagnosticsExportRequest, type DiagnosticsExportOutcome } from "@octant/contracts";
import { authorizeDiagnosticsExportActor } from "@octant/domain";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { exportDiagnosticsEvidence } from "./diagnosticsExportService";
import type { Journal } from "./persistence/journal";
import type { SqliteConnection } from "./persistence/sqlitePort";

/**
 * The one browser-first HTTP entry point for the authenticated
 * diagnostics export command. Mirrors `./usageRoutes.ts` exactly — loopback
 * only, allow-listed renderer origin, and `authenticateRouteWindowId` as the
 * local-authenticated-user gate — so a remote device, a provider process, an
 * automation/agent run, or an extension all fail closed before
 * `exportDiagnosticsEvidence` (and therefore the redaction/sealing
 * policy) is ever reached.
 */

const METHODS = "POST, OPTIONS";
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
    if (url.pathname !== "/api/diagnostics/export") return undefined;

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
    if (request.method !== "POST") {
      return failureResponse("Diagnostics export requires POST.", 405, origin);
    }

    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Diagnostics export is unauthorized.", 401, origin);
      }
      return failureResponse("Diagnostics export request is invalid.", 400, origin);
    }

    // Defense in depth: the window-capability check above already guarantees
    // a local-window actor, but every path to `exportDiagnosticsEvidence`
    // must be provably gated by the same single source of truth used for
    // remote-device, provider, automation, and extension callers.
    const authorization = authorizeDiagnosticsExportActor("local-window");
    if (authorization.kind === "denied") {
      return failureResponse("Diagnostics export is unauthorized.", 401, origin);
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
      octantVersion: dependencies.octantVersion ?? "0.0.0-dev",
      clock,
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

function isAllowedOrigin(origin: string): boolean {
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
