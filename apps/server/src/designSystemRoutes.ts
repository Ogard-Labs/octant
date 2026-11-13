import {
  decodeDesignSystemWriteRequest,
  decodeProjectId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { designSystemFolders, type DesignSystemFiles } from "./designSystems/designSystemFiles";
import type { ProjectService } from "./projectService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const LIST_PATH = "/api/design-systems";
const FILE_PATH = "/api/design-systems/file";
const MAX_BODY_BYTES = 300_000;

export interface DesignSystemRouteDependencies {
  readonly files: Pick<DesignSystemFiles, "list" | "read" | "write">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The design systems of a Project the window has open: list, read, create,
 * and save its `DESIGN.md` files.
 *
 * Only the host's own person may use these routes: at a window on this host,
 * or on a device that person paired (maintainer decision, 2026-11-13). They
 * read and write the person's folder directly, the way the person's own
 * editor would, so every other device session is refused. The Project must be
 * an active one, and the folder one that Project lends. A save writes the
 * file and journals nothing, for a window as for a device.
 */
export function createDesignSystemRouteHandler(dependencies: DesignSystemRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== LIST_PATH && url.pathname !== FILE_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("invalid", "Design system requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("invalid", "Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const isWrite = url.pathname === FILE_PATH && request.method === "POST";
    if (request.method !== "GET" && !isWrite) {
      return failure("unsupported", "Design systems do not support this method.", 405, origin);
    }

    let windowId: WindowId;
    try {
      const principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (!principalActsAsHostPerson(principal.principal)) {
        return failure(
          "unauthorized",
          "Design systems are open only to the host's own person.",
          403,
          origin,
        );
      }
      windowId = principal.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("unauthorized", "Design system request is unauthorized.", 401, origin);
      }
      return failure("invalid", "Design system request is invalid.", 400, origin);
    }

    let body: ReturnType<typeof decodeDesignSystemWriteRequest> | undefined;
    if (isWrite) {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > MAX_BODY_BYTES)
        return failure("invalid", "Design system is too large.", 413, origin);
      try {
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES)
          return failure("invalid", "Design system is too large.", 413, origin);
        body = decodeDesignSystemWriteRequest(JSON.parse(raw));
      } catch {
        return failure("invalid", "Design system save is invalid.", 400, origin);
      }
    }

    const projectIdRaw = body?.projectId ?? url.searchParams.get("projectId");
    let projectId: ProjectId;
    try {
      projectId = decodeProjectId(projectIdRaw ?? "");
    } catch {
      return failure("invalid", "Design system requests require a valid projectId.", 400, origin);
    }
    const bootstrap = await dependencies.projects.bootstrap(windowId);
    const project = bootstrap.active.find(
      (candidate) => String(candidate.id) === String(projectId),
    );
    const folders = project === undefined ? undefined : designSystemFolders(project);
    if (folders === undefined) {
      return failure("not-found", "This Project has no folder for a design system.", 404, origin);
    }

    if (url.pathname === LIST_PATH) {
      return json(await dependencies.files.list(folders), 200, origin);
    }
    if (body !== undefined) {
      const result = await dependencies.files.write(
        folders,
        { folder: body.folder, path: body.path },
        body.text,
        body.baseRevision,
      );
      return json(result, 200, origin);
    }
    const folder = url.searchParams.get("folder");
    const path = url.searchParams.get("path");
    if (folder === null || path === null) {
      return failure("invalid", "Reading a design system names its folder and path.", 400, origin);
    }
    let location;
    try {
      location = decodeDesignSystemWriteRequest({ projectId, folder, path, text: "" });
    } catch {
      return failure("invalid", "That is not a design system path.", 400, origin);
    }
    const document = await dependencies.files.read(folders, {
      folder: location.folder,
      path: location.path,
    });
    return document === undefined
      ? failure("not-found", "That design system cannot be read.", 404, origin)
      : json(document, 200, origin);
  };
}

/** Failures take the Project route's shape, so the Project client reads them alike. */
function failure(
  category: "invalid" | "unauthorized" | "not-found" | "unsupported",
  message: string,
  status: number,
  origin: string | null,
): Response {
  return json({ category, message }, status, origin);
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
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
