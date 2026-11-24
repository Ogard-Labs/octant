import {
  REPOSITORY_BOOTSTRAP_LAND_FILES_MAX_BODY_BYTES,
  decodeRepositoryBootstrapCancelCloneRequest,
  decodeRepositoryBootstrapCloneStatusRequest,
  decodeRepositoryBootstrapInspectRequest,
  decodeRepositoryBootstrapLandFilesRequest,
  decodeRepositoryBootstrapReadFileRequest,
  decodeRepositoryBootstrapStartCloneRequest,
  type RepositoryBootstrapFailure,
} from "@octant/contracts/repository-bootstrap";
import { isAgentGrantSession, principalActsAsHostPerson } from "./clientPrincipal";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import {
  type RepositoryBootstrapService,
  type RepositoryBootstrapServiceResult,
} from "./repositoryBootstrapService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export const REPOSITORY_BOOTSTRAP_SOURCE_PATHS = [
  "/api/projects/repository-bootstrap/inspect",
  "/api/projects/repository-bootstrap/read-ignored-file",
] as const;

export const REPOSITORY_BOOTSTRAP_RECEIVING_PATHS = [
  "/api/projects/repository-bootstrap/clone",
  "/api/projects/repository-bootstrap/clone/status",
  "/api/projects/repository-bootstrap/clone/cancel",
  "/api/projects/repository-bootstrap/land-files",
] as const;

export interface RepositoryBootstrapRouteDependencies {
  readonly service: RepositoryBootstrapService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function failureResponse(failure: RepositoryBootstrapFailure, origin: string | null): Response {
  const status =
    failure.code === "unauthorized"
      ? 403
      : failure.code === "not-found"
        ? 404
        : failure.code === "destination-not-empty"
          ? 409
          : failure.code === "unavailable"
            ? 503
            : 400;
  return Response.json(failure, { status, headers: corsHeaders(origin) });
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://" || origin === "null") return true;
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

export function createRepositoryBootstrapRouteHandler(
  dependencies: RepositoryBootstrapRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const defaultBodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isInspect = pathname === "/api/projects/repository-bootstrap/inspect";
    const isReadIgnoredFile = pathname === "/api/projects/repository-bootstrap/read-ignored-file";
    const isStartClone = pathname === "/api/projects/repository-bootstrap/clone";
    const isCloneStatus = pathname === "/api/projects/repository-bootstrap/clone/status";
    const isCancelClone = pathname === "/api/projects/repository-bootstrap/clone/cancel";
    const isLandFiles = pathname === "/api/projects/repository-bootstrap/land-files";

    if (
      !isInspect &&
      !isReadIgnoredFile &&
      !isStartClone &&
      !isCloneStatus &&
      !isCancelClone &&
      !isLandFiles
    ) {
      return undefined;
    }

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { code: "invalid", message: "Repository bootstrap requests must use loopback." },
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { code: "invalid", message: "Renderer origin is not allowed." },
        origin,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return failureResponse(
        { code: "invalid", message: "Repository bootstrap requires POST." },
        origin,
      );
    }

    let windowId;
    try {
      // Only a local window or a device paired by this computer's own person
      // may inspect, clone, or land ignored files here. Hub-introduced devices
      // without host-person standing and agent grants are refused.
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (!principalActsAsHostPerson(context.principal) || isAgentGrantSession(context.principal)) {
        return Response.json(
          {
            code: "unauthorized",
            message: "Adding a repository on this computer requires its own person.",
          } satisfies RepositoryBootstrapFailure,
          { status: 403, headers: corsHeaders(origin) },
        );
      }
      windowId = context.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return Response.json(
          {
            code: "unauthorized",
            message: "Repository bootstrap is unauthorized.",
          } satisfies RepositoryBootstrapFailure,
          { status: 401, headers: corsHeaders(origin) },
        );
      }
      return failureResponse(
        { code: "invalid", message: "Repository bootstrap request is invalid." },
        origin,
      );
    }

    const bodyLimit = isLandFiles
      ? Math.max(defaultBodyLimit, REPOSITORY_BOOTSTRAP_LAND_FILES_MAX_BODY_BYTES)
      : defaultBodyLimit;
    const decodedBody = await readJson(request, bodyLimit);
    if (decodedBody.kind === "too-large") {
      return Response.json(
        {
          code: "invalid",
          message: "Request body is too large.",
        } satisfies RepositoryBootstrapFailure,
        { status: 413, headers: corsHeaders(origin) },
      );
    }
    if (decodedBody.kind === "invalid") {
      return failureResponse(
        { code: "invalid", message: "Request body must be valid JSON." },
        origin,
      );
    }

    const respond = <T>(result: RepositoryBootstrapServiceResult<T>): Response =>
      result.status === "refused"
        ? failureResponse(result.failure, origin)
        : Response.json(result.value, { status: 200, headers: corsHeaders(origin) });

    try {
      if (isInspect) {
        const payload = decodePayload(() =>
          decodeRepositoryBootstrapInspectRequest(decodedBody.value),
        );
        if (payload.status === "refused") return failureResponse(payload.failure, origin);
        return respond(await dependencies.service.inspect(payload.value, request.signal));
      }
      if (isReadIgnoredFile) {
        const payload = decodePayload(() =>
          decodeRepositoryBootstrapReadFileRequest(decodedBody.value),
        );
        if (payload.status === "refused") return failureResponse(payload.failure, origin);
        return respond(await dependencies.service.readIgnoredFile(payload.value, request.signal));
      }
      if (isStartClone) {
        const payload = decodePayload(() =>
          decodeRepositoryBootstrapStartCloneRequest(decodedBody.value),
        );
        if (payload.status === "refused") return failureResponse(payload.failure, origin);
        return respond(await dependencies.service.startClone(windowId, payload.value));
      }
      if (isCloneStatus) {
        const payload = decodePayload(() =>
          decodeRepositoryBootstrapCloneStatusRequest(decodedBody.value),
        );
        if (payload.status === "refused") return failureResponse(payload.failure, origin);
        return respond(dependencies.service.cloneStatus(windowId, payload.value));
      }
      if (isCancelClone) {
        const payload = decodePayload(() =>
          decodeRepositoryBootstrapCancelCloneRequest(decodedBody.value),
        );
        if (payload.status === "refused") return failureResponse(payload.failure, origin);
        return respond(await dependencies.service.cancelClone(windowId, payload.value));
      }
      const payload = decodePayload(() =>
        decodeRepositoryBootstrapLandFilesRequest(decodedBody.value),
      );
      if (payload.status === "refused") return failureResponse(payload.failure, origin);
      return respond(await dependencies.service.landFiles(windowId, payload.value));
    } catch {
      return failureResponse(
        { code: "unavailable", message: "Repository bootstrap service is unavailable." },
        origin,
      );
    }
  };
}

function decodePayload<T>(decode: () => T): RepositoryBootstrapServiceResult<T> {
  try {
    return { status: "ok", value: decode() };
  } catch {
    return {
      status: "refused",
      failure: {
        code: "invalid",
        message: "Repository bootstrap request payload is invalid.",
      },
    };
  }
}
