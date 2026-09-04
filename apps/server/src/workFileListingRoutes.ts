import {
  decodeProjectId,
  decodeWorkFileListingResult,
  decodeWorkThreadId,
  type ProjectId,
  type WorkFileListingResult,
  type WorkThreadId,
  type WindowId,
} from "@octant/contracts";
import type { PersistenceService } from "./persistence/persistenceService";
import type { ProjectService } from "./projectService";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { WorkFileListingService } from "./work/workFileListingService";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

class WorkFileListingRouteRejected extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface WorkFileListingRouteDependencies {
  readonly service: Pick<WorkFileListingService, "list">;
  readonly persistence: Pick<PersistenceService, "readProject">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Read-only listing of the folder a Work thread's Project is bound to.
 *
 * The route grants nothing: the canonical root comes from the Project the
 * window can already reach, never from the query, so a client cannot name a
 * folder and have it listed. Everything below that root is bounded and
 * confined by the listing service itself.
 */
export function createWorkFileListingRouteHandler(dependencies: WorkFileListingRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/work/files/listing") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "invalid", message: "Work file listing requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { category: "invalid", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failureResponse(
        { category: "invalid", message: "Work file listing request is invalid." },
        400,
        origin,
      );
    }

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        throw new WorkFileListingRouteRejected(
          "Work file listing requests cannot supply window identity.",
          400,
        );
      }
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { category: "unauthorized", message: "Work file listing is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        {
          category: "invalid",
          message:
            error instanceof WorkFileListingRouteRejected
              ? error.message
              : "Work file listing request is invalid.",
        },
        error instanceof WorkFileListingRouteRejected ? error.status : 400,
        origin,
      );
    }

    try {
      const { projectId, threadId, directory } = decodeListingParams(url);
      const project = await loadAccessibleWorkProject(
        dependencies.projects,
        dependencies.persistence,
        authenticatedWindowId,
        projectId,
      );
      const result = await dependencies.service.list({
        threadId,
        projectId,
        rootPath: project.binding.canonicalRoot,
        ...(directory === undefined ? {} : { directory }),
        signal: request.signal,
      });
      return jsonResponse(decodeWorkFileListingResult(result), 200, origin);
    } catch (error) {
      if (error instanceof WorkFileListingRouteRejected) {
        return failureResponse(
          { category: error.status === 404 ? "not-found" : "invalid", message: error.message },
          error.status,
          origin,
        );
      }
      return failureResponse(
        { category: "unavailable", message: "Work file listing is unavailable." },
        503,
        origin,
      );
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
    throw new WorkFileListingRouteRejected("Work Project is unavailable for this window.", 404);
  }
  const project = persistence.readProject(projectId);
  if (project === undefined || project.type !== "work" || project.lifecycle !== "active") {
    throw new WorkFileListingRouteRejected("Work Project is unavailable for this window.", 404);
  }
  return project;
}

function decodeListingParams(url: URL): {
  readonly projectId: ProjectId;
  readonly threadId: WorkThreadId;
  readonly directory: string | undefined;
} {
  for (const key of url.searchParams.keys()) {
    if (key !== "projectId" && key !== "threadId" && key !== "directory") {
      throw new WorkFileListingRouteRejected("Work file listing request is invalid.", 400);
    }
  }
  const projectIdRaw = url.searchParams.get("projectId");
  const threadIdRaw = url.searchParams.get("threadId");
  if (projectIdRaw === null || threadIdRaw === null) {
    throw new WorkFileListingRouteRejected(
      "Work file listing requires projectId and threadId.",
      400,
    );
  }
  let projectId: ProjectId;
  let threadId: WorkThreadId;
  try {
    projectId = decodeProjectId(projectIdRaw);
    threadId = decodeWorkThreadId(threadIdRaw);
  } catch {
    throw new WorkFileListingRouteRejected("Work file listing identity is invalid.", 400);
  }
  const directoryRaw = url.searchParams.get("directory");
  const directory =
    directoryRaw === null || directoryRaw.trim() === "" ? undefined : directoryRaw.trim();
  return { projectId, threadId, directory };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failureResponse(
  failure: { readonly category: string; readonly message: string },
  status: number,
  origin: string | null,
): Response {
  return jsonResponse({ status: "failed", failure }, status, origin);
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

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "origin",
  };
}

export type { WorkFileListingResult };
