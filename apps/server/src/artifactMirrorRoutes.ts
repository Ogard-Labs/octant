import { decodeArtifactMirrorCommand } from "@octant/contracts/artifact-mirror";
import type { ArtifactMirrorService } from "./canvas/artifactMirrorService";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ArtifactMirrorRouteDependencies {
  readonly mirror: ArtifactMirrorService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Where artifacts are mirrored, and the one command that takes an edited file
 * back in.
 *
 * Reading the setting is ordinary. Changing it is not: it names a folder on
 * this machine, so it stays with the person at the machine. A paired device is
 * refused here rather than at the service, because a remote caller has no
 * business naming a local path at all — and re-import is refused for the same
 * reason, since it reads a file only the host can see.
 */
export function createArtifactMirrorRouteHandler(deps: ArtifactMirrorRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname !== "/api/artifacts/mirror") return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Artifact mirror requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // A forwarded remote request carries a bound principal. Naming a folder on
    // this machine is host work, so a paired device is turned away before the
    // command is even decoded.
    if (readPrincipalRouteContext(request)?.principal.kind === "remote-device") {
      return failure("Artifact mirroring is settled on the host.", 403, origin);
    }
    try {
      authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Artifact mirror request is unauthorized.", 401, origin)
        : failure("Artifact mirror request is invalid.", 400, origin);
    }

    if (request.method === "GET") return json({ settings: deps.mirror.settings() }, origin);
    if (request.method !== "POST") return undefined;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("Artifact mirror command is invalid.", 400, origin);
    }
    let command: ReturnType<typeof decodeArtifactMirrorCommand>;
    try {
      command = decodeArtifactMirrorCommand(body);
    } catch {
      return failure("Artifact mirror command is invalid.", 400, origin);
    }
    try {
      return json(await deps.mirror.execute(command), origin);
    } catch {
      return failure("Artifact mirror command failed.", 500, origin);
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
