import {
  decodeWorkResearchCommand,
  decodeWorkResearchCommandResult,
  type WorkResearchCommand,
  type WorkResearchCommandResult,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { WorkResearchBriefEntry } from "./work/workResearchProjection";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import type { PersistenceService } from "./persistence/persistenceService";
import type { ProjectService } from "./projectService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const COMMANDS_PATH = "/api/work/research/commands";
const BRIEFS_PATH = "/api/work/research/briefs";
const UNREBUILT_MESSAGE =
  "Work research is unavailable on this host until its projection is rebuilt from the journal.";

export interface WorkResearchRouteDependencies {
  readonly service: {
    execute(
      command: WorkResearchCommand,
      options?: { readonly signal?: AbortSignal },
    ): Promise<WorkResearchCommandResult>;
  };
  readonly projection: {
    snapshot(): ReadonlyMap<unknown, WorkResearchBriefEntry>;
  };
  /**
   * Whether the projection is a faithful rebuild of the authoritative journal.
   * False when the event store reported `snapshot-required`, in which case the
   * projection holds fewer briefs than the journal does. The route then answers
   * unavailable for every research request so a caller can tell "this host
   * cannot currently read your briefs" from "you have no briefs", and so a
   * mutation never reports a durable brief missing.
   */
  readonly projectionRebuilt: () => boolean;
  readonly persistence: Pick<PersistenceService, "readProject">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

/**
 * Authoritative Work research surface.
 *
 * The service, event store, and projection enforce provenance, source policy,
 * and citation authority; this route only proves window authority and that the
 * command's Project is an active Work Project reachable from that window,
 * then hands the decoded command to the service. Project access is re-checked
 * per request rather than trusted from the renderer.
 */
export function createWorkResearchRouteHandler(dependencies: WorkResearchRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_PATH && url.pathname !== BRIEFS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Work research API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === BRIEFS_PATH) {
      return await handleBriefs(dependencies, request, url, origin, now);
    }
    return await handleCommand(dependencies, request, url, origin, now, jsonLimit);
  };
}

async function handleBriefs(
  dependencies: WorkResearchRouteDependencies,
  request: Request,
  url: URL,
  origin: string | null,
  now: () => number,
): Promise<Response> {
  if (request.method !== "GET") {
    return failure("Work research request is invalid.", 400, origin);
  }
  const rawProjectId = url.searchParams.get("projectId");
  if (rawProjectId === null || rawProjectId.length === 0) {
    return failure("projectId is required.", 400, origin);
  }

  let authenticatedWindowId: WindowId;
  try {
    authenticatedWindowId = authenticateProjectRequest({
      request,
      body: undefined,
      store: dependencies.windowAuthorityStore,
      now: now(),
    });
  } catch (error) {
    return authFailure(error, origin);
  }

  const projectId = rawProjectId as ProjectId;
  try {
    await assertAccessibleWorkProject(dependencies, authenticatedWindowId, projectId);
  } catch (error) {
    if (error instanceof WorkResearchRouteRejected) {
      return failure(error.message, error.status, origin);
    }
    return failure("Octant Work research service is unavailable.", 503, origin);
  }

  if (!dependencies.projectionRebuilt()) {
    return failure(UNREBUILT_MESSAGE, 503, origin);
  }

  // Briefs are projected per Project; a window never observes another
  // Project's research even when it holds a valid capability.
  const briefs = [...dependencies.projection.snapshot().values()]
    .filter((entry) => String(entry.brief.projectId) === String(projectId))
    .map(serializeBrief);
  return json({ briefs }, 200, origin);
}

async function handleCommand(
  dependencies: WorkResearchRouteDependencies,
  request: Request,
  url: URL,
  origin: string | null,
  now: () => number,
  jsonLimit: number,
): Promise<Response> {
  if (request.method !== "POST" || url.search !== "") {
    return failure("Work research request is invalid.", 400, origin);
  }

  let body: unknown;
  try {
    requireJsonContentType(request);
    body = parseJson(await readBoundedBytes(request, jsonLimit));
  } catch (error) {
    if (error instanceof WorkResearchRouteRejected) {
      return failure(error.message, error.status, origin);
    }
    return failure("Work research request is invalid.", 400, origin);
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
    return authFailure(error, origin);
  }

  let command: WorkResearchCommand;
  try {
    command = decodeWorkResearchCommand(body);
  } catch {
    return failure("Work research command is invalid.", 400, origin);
  }

  try {
    await assertAccessibleWorkProject(dependencies, authenticatedWindowId, command.projectId);
    if (!dependencies.projectionRebuilt()) {
      throw new WorkResearchRouteRejected(UNREBUILT_MESSAGE, 503);
    }
    const result = await dependencies.service.execute(command, { signal: request.signal });
    return json(decodeWorkResearchCommandResult(result), 200, origin);
  } catch (error) {
    if (error instanceof WorkResearchRouteRejected) {
      return failure(error.message, error.status, origin);
    }
    return failure("Octant Work research service is unavailable.", 503, origin);
  }
}

/**
 * Serialize a projected brief for the renderer. Sources keep their confined
 * relative `sourceRef` and never gain a host path, matching the Work rule
 * that the renderer never receives an absolute filesystem location.
 */
function serializeBrief(entry: WorkResearchBriefEntry) {
  return {
    briefId: entry.briefId,
    brief: entry.brief,
    sources: [...entry.sources.values()],
    revokedSourceIds: [...entry.revokedSourceIds],
    evidence: entry.evidence,
    claims: entry.claims,
    ...(entry.report === undefined ? {} : { report: entry.report }),
  };
}

async function assertAccessibleWorkProject(
  dependencies: WorkResearchRouteDependencies,
  authenticatedWindowId: WindowId,
  projectId: ProjectId,
): Promise<void> {
  const bootstrap = await dependencies.projects.bootstrap(authenticatedWindowId);
  const accessible = bootstrap.active.find((candidate) => candidate.id === projectId);
  if (accessible === undefined || accessible.type !== "work" || accessible.lifecycle !== "active") {
    throw new WorkResearchRouteRejected("Work Project is unavailable for this window.", 404);
  }
  const project = dependencies.persistence.readProject(projectId);
  if (project === undefined || project.type !== "work" || project.lifecycle !== "active") {
    throw new WorkResearchRouteRejected("Work Project is unavailable for this window.", 404);
  }
}

function authFailure(error: unknown, origin: string | null): Response {
  if (error instanceof WindowAuthorityError) {
    return failure("Work research request is unauthorized.", 401, origin);
  }
  return failure("Work research request is invalid.", 400, origin);
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ message }, status, origin);
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new WorkResearchRouteRejected("Work research content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkResearchRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new WorkResearchRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new WorkResearchRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkResearchRouteRejected("Work research body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkResearchRouteRejected("Work research body must be valid JSON.", 400);
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

class WorkResearchRouteRejected extends Error {
  override readonly name = "WorkResearchRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
