import {
  decodeLocalServerCommand,
  decodeLocalServerCommandResult,
  type LocalServerCommand,
  type LocalServerCommandResult,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { LocalServerActor } from "@octant/domain";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import type { PersistenceService } from "./persistence/persistenceService";
import { readPrincipalRouteContext } from "./principalRouteContext";
import type { ProjectService } from "./projectService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 65_536;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const COMMANDS_PATH = "/api/code/local-servers/commands";

export interface LocalServerRouteDependencies {
  readonly service: {
    execute(
      authenticatedWindowId: WindowId,
      command: LocalServerCommand,
      options: { readonly actor: LocalServerActor; readonly signal?: AbortSignal },
    ): Promise<LocalServerCommandResult>;
  };
  readonly persistence: Pick<PersistenceService, "readProject">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

/**
 * Authoritative Local servers surface for bound Code threads.
 *
 * The service owns classification, health, and the stop policy; this route only
 * proves window authority and that the command's Project is an active Code
 * Project reachable from that window, then hands the decoded command over with
 * the actor the request's authenticated principal establishes.
 * Project access is re-checked per request rather than trusted from the
 * renderer, because a stale renderer must never be able to aim a stop at a
 * Project the window has since lost.
 */
export function createLocalServerRouteHandler(dependencies: LocalServerRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Local servers API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("Local servers request is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      requireJsonContentType(request);
      body = parseJson(await readBoundedBytes(request, jsonLimit));
    } catch (error) {
      if (error instanceof LocalServerRouteRejected) {
        return failure(error.message, error.status, origin);
      }
      return failure("Local servers request is invalid.", 400, origin);
    }

    let authenticatedWindowId: WindowId;
    try {
      authenticatedWindowId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Local servers request is unauthorized.", 401, origin)
        : failure("Local servers request is invalid.", 400, origin);
    }

    let command: LocalServerCommand;
    try {
      command = decodeLocalServerCommand(body);
    } catch {
      return failure("Local servers command is invalid.", 400, origin);
    }

    try {
      await assertAccessibleCodeProject(dependencies, authenticatedWindowId, command.projectId);
      const result = await dependencies.service.execute(authenticatedWindowId, command, {
        actor: requestActor(request),
        signal: request.signal,
      });
      return json(decodeLocalServerCommandResult(result), 200, origin);
    } catch (error) {
      if (error instanceof LocalServerRouteRejected) {
        return failure(error.message, error.status, origin);
      }
      return failure("Octant Local servers service is unavailable.", 503, origin);
    }
  };
}

/**
 * The transport principal is authoritative. A local window is the host user; a
 * request the remote gateway authenticated carries a bound remote-device
 * principal and stays `remote-client`, so the domain policy keeps a leftover
 * Stop on the host. Anything without a bound context reached this handler on
 * the loopback listener under a proven window capability.
 */
function requestActor(request: Request): LocalServerActor {
  return readPrincipalRouteContext(request)?.principal.kind === "remote-device"
    ? "remote-client"
    : "local-user";
}

async function assertAccessibleCodeProject(
  dependencies: LocalServerRouteDependencies,
  authenticatedWindowId: WindowId,
  projectId: ProjectId,
): Promise<void> {
  const bootstrap = await dependencies.projects.bootstrap(authenticatedWindowId);
  const accessible = bootstrap.active.find((candidate) => candidate.id === projectId);
  if (accessible === undefined || accessible.type !== "code" || accessible.lifecycle !== "active") {
    throw new LocalServerRouteRejected("Code Project is unavailable for this window.", 404);
  }
  const project = dependencies.persistence.readProject(projectId);
  if (project === undefined || project.type !== "code" || project.lifecycle !== "active") {
    throw new LocalServerRouteRejected("Code Project is unavailable for this window.", 404);
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ message }, status, origin);
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new LocalServerRouteRejected("Local servers content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new LocalServerRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new LocalServerRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new LocalServerRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalServerRouteRejected("Local servers body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalServerRouteRejected("Local servers body must be valid JSON.", 400);
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return (
      origin === parsed.origin &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

class LocalServerRouteRejected extends Error {
  override readonly name = "LocalServerRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
