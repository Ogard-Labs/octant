import {
  decodeWorkOverviewProjection,
  decodeProjectId,
  decodeWorkThreadId,
  type WorkOverviewProjection,
  type WorkRequest,
  type WorkThreadId,
  type Workflow,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { composeWorkOverviewProjection } from "./work/workOverviewComposer";
import type { WorkArtifactProjection } from "./work/workArtifactProjection";
import type { WorkThreadRouteService } from "./workThreadRoutes";
import type { ProjectService } from "./projectService";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface WorkOverviewWorkflowSource {
  readonly listByProject: (projectId: ProjectId) => ReadonlyArray<Workflow>;
  readonly hasActiveForThread?: (projectId: ProjectId, threadId: WorkThreadId) => boolean;
}

export interface WorkOverviewRequestsPort {
  listPending(projectId: ProjectId): ReadonlyArray<WorkRequest>;
}

export interface WorkOverviewRouteDependencies {
  readonly artifacts: WorkArtifactProjection;
  readonly threads: Pick<WorkThreadRouteService, "bootstrap">;
  readonly workflows?: WorkOverviewWorkflowSource;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly requests: WorkOverviewRequestsPort;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

export function createWorkOverviewRouteHandler(dependencies: WorkOverviewRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/work/overview") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Work overview API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failureResponse("Work overview only supports GET.", 405, origin);
    }

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        return failureResponse(
          "Work overview requests cannot supply window identity.",
          400,
          origin,
        );
      }
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Work overview request is unauthorized.", 401, origin);
      }
      return failureResponse("Work overview request is invalid.", 400, origin);
    }

    const projectIdRaw = url.searchParams.get("projectId");
    if (projectIdRaw === null || projectIdRaw.trim() === "") {
      return failureResponse("Work overview requires projectId.", 400, origin);
    }
    let projectId: ProjectId;
    try {
      projectId = decodeProjectId(projectIdRaw);
    } catch {
      return failureResponse("Work overview projectId is invalid.", 400, origin);
    }

    const bootstrap = await dependencies.projects.bootstrap(authenticatedWindowId);
    const project = bootstrap.active.find((candidate) => candidate.id === projectId);
    if (project === undefined || project.type !== "work") {
      return failureResponse("Work Project is unavailable for this window.", 404, origin);
    }

    const workflowSource = dependencies.workflows;
    const projection: WorkOverviewProjection = composeWorkOverviewProjection(
      dependencies.artifacts,
      projectId,
      (await dependencies.threads.bootstrap(authenticatedWindowId)).threads,
      workflowSource?.listByProject(projectId) ?? [],
      workflowSource?.hasActiveForThread === undefined
        ? undefined
        : (threadId) =>
            workflowSource.hasActiveForThread?.(projectId, decodeWorkThreadId(threadId)) ?? false,
      dependencies.requests.listPending(projectId),
    );
    return jsonResponse(decodeWorkOverviewProjection(projection), 200, origin);
  };
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ message }, status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json",
    },
  });
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "access-control-allow-origin": origin ?? "null",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:"
      ? isLoopbackHostname(url.hostname)
      : url.protocol === "app:" || url.protocol === "file:";
  } catch {
    return false;
  }
}
