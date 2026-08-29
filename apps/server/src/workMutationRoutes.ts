import {
  decodeWorkMutationReply,
  decodeWorkMutationRequest,
  type WorkMutationReply,
  type WorkMutationRequest,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { classifyDestructiveChange, type WorkMutationKind } from "@octant/domain";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import type { PersistenceService } from "./persistence/persistenceService";
import type { ProjectService } from "./projectService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface WorkMutationRouteDependencies {
  readonly service: {
    mutate(
      request: WorkMutationRequest,
      context: {
        readonly binding: {
          readonly canonicalRoot: string;
          readonly knownCanonicalRoot: string;
          readonly availability: "available";
          readonly bindingSuperseded: false;
        };
        readonly posture: "full";
        readonly approved: boolean;
        readonly signal?: AbortSignal;
      },
    ): Promise<WorkMutationReply>;
  };
  readonly persistence: Pick<PersistenceService, "readProject">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createWorkMutationRouteHandler(dependencies: WorkMutationRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/work/mutations") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Work mutation API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failureResponse("Work mutation request is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      requireJsonContentType(request);
      body = parseJson(await readBoundedBytes(request, jsonLimit));
    } catch (error) {
      if (error instanceof WorkMutationRouteRejected) {
        return failureResponse(error.message, error.status, origin);
      }
      return failureResponse("Work mutation request is invalid.", 400, origin);
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
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Work mutation request is unauthorized.", 401, origin);
      }
      return failureResponse("Work mutation request is invalid.", 400, origin);
    }

    let mutation: WorkMutationRequest;
    try {
      mutation = decodeWorkMutationRequest(body);
    } catch {
      return failureResponse("Work mutation request is invalid.", 400, origin);
    }

    try {
      const project = await loadAccessibleWorkProject(
        dependencies.projects,
        dependencies.persistence,
        authenticatedWindowId,
        mutation.projectId,
      );
      const reply = await dependencies.service.mutate(mutation, {
        binding: {
          canonicalRoot: project.binding.canonicalRoot,
          knownCanonicalRoot: project.binding.canonicalRoot,
          availability: "available",
          bindingSuperseded: false,
        },
        posture: "full",
        approved: userInitiatedMutationApproved(mutation),
        signal: request.signal,
      });
      return jsonResponse(decodeWorkMutationReply(reply), 200, origin);
    } catch (error) {
      if (error instanceof WorkMutationRouteRejected) {
        return failureResponse(error.message, error.status, origin);
      }
      return failureResponse("Octant Work mutation service is unavailable.", 503, origin);
    }
  };
}

async function loadAccessibleWorkProject(
  projects: Pick<ProjectService, "bootstrap">,
  persistence: Pick<PersistenceService, "readProject">,
  authenticatedWindowId: WindowId,
  projectId: ProjectId,
) {
  const bootstrap = await projects.bootstrap(authenticatedWindowId);
  const accessible = bootstrap.active.find((candidate) => candidate.id === projectId);
  if (accessible === undefined || accessible.type !== "work" || accessible.lifecycle !== "active") {
    throw new WorkMutationRouteRejected("Work Project is unavailable for this window.", 404);
  }
  const project = persistence.readProject(projectId);
  if (project === undefined || project.type !== "work" || project.lifecycle !== "active") {
    throw new WorkMutationRouteRejected("Work Project is unavailable for this window.", 404);
  }
  return project;
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ message }, status, origin);
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new WorkMutationRouteRejected("Work mutation content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkMutationRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new WorkMutationRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new WorkMutationRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkMutationRouteRejected("Work mutation body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkMutationRouteRejected("Work mutation body must be valid JSON.", 400);
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

function userInitiatedMutationApproved(request: WorkMutationRequest): boolean {
  const change = classifyDestructiveChange({
    kind: mutationKindForRequest(request),
    ...(request.kind === "create-artifact" ? { format: request.format } : {}),
    ...(request.kind === "transform-artifact" ? { targetFormat: request.targetFormat } : {}),
  });
  if (!change.requiresApproval) return true;
  return request.confirmed === true;
}

function mutationKindForRequest(request: WorkMutationRequest): WorkMutationKind {
  switch (request.kind) {
    case "create-artifact":
      return "create";
    case "revise-artifact":
      return "revise";
    case "transform-artifact":
      return "transform";
    case "rename-artifact":
      return "rename";
    case "delete-artifact":
      return "delete";
    case "version-artifact":
      return "version";
    case "export-artifact":
      return "export";
  }
}

class WorkMutationRouteRejected extends Error {
  override readonly name = "WorkMutationRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
