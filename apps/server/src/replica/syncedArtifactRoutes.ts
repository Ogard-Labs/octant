import {
  decodeArtifactSyncedCommand,
  type ArtifactSyncedCommand,
} from "@octant/contracts/artifact-library";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { SyncedArtifactService } from "./syncedArtifactService";

const PATH = "/api/artifacts/synced";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface SyncedArtifactRouteDependencies {
  readonly service: Pick<SyncedArtifactService, "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Synced artifacts: which computer wrote each version, open one in a thread,
 * keep one of two versions, merge them, or restore one deleted elsewhere.
 *
 * Every command is host work. Opening binds content to a thread here, and the
 * others publish to the person's store, so a paired device is refused before
 * the command is decoded, the same as the library lists it no synced entries.
 */
export function createSyncedArtifactRouteHandler(deps: SyncedArtifactRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname !== PATH) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Synced artifact requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return undefined;

    if (readPrincipalRouteContext(request)?.principal.kind === "remote-device") {
      return failure("Synced artifacts are settled on the host.", 403, origin);
    }
    try {
      authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Synced artifact request is unauthorized.", 401, origin)
        : failure("Synced artifact request is invalid.", 400, origin);
    }

    let command: ArtifactSyncedCommand;
    try {
      command = decodeArtifactSyncedCommand(await request.json());
    } catch {
      return failure("Synced artifact command is invalid.", 400, origin);
    }
    try {
      return json(await deps.service.execute(command), origin);
    } catch {
      return failure("Synced artifact command failed.", 500, origin);
    }
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function json(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
