import {
  decodeAutomationCommandResult,
  decodeAutomationId,
  decodeAutomationQueryResponse,
  decodeProjectId,
  MAX_AUTOMATION_HISTORY_ENTRIES,
  MAX_AUTOMATION_QUERY_CURSOR_LENGTH,
  MAX_AUTOMATION_QUERY_LIMIT,
  type AutomationCommand,
  type AutomationCommandFailure,
  type AutomationDefinition,
  type AutomationId,
  type HostId,
  type ProjectId,
} from "@octant/contracts";
import { ClientPrincipalError } from "../clientPrincipal";
import { resolvePrincipalRouteContext, type PrincipalRouteContext } from "../principalRouteContext";
import type { ProjectService } from "../projectService";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { AutomationCommandService } from "./automationCommandService";
import type { AutomationProjection } from "./automationProjection";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_048_576;
const DEFAULT_PAGE_LIMIT = 50;
const DETAIL_RUNS_LIMIT = 50;

export interface AutomationRouteDependencies {
  readonly projection: AutomationProjection;
  readonly commands: Pick<AutomationCommandService, "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projects: Pick<ProjectService, "bootstrap">;
  /** The identity of the host that owns every Automation this server holds. */
  readonly hostId: string;
  readonly now?: () => number;
}

/**
 * Authenticated Automation Center routes. Every request must arrive on
 * loopback (directly, or rewritten by the remote gateway after device
 * authentication), carry a verifiable principal, and pass exact Project
 * access checks before the projection is read or a command reaches the
 * journal. Principals and origins are injected from the authenticated
 * transport only; request bodies cannot supply them.
 */
export function createAutomationRouteHandler(dependencies: AutomationRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/automations")) return undefined;
    const route = url.pathname.slice("/api/automations".length).replace(/^\//, "");

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Automation API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let body: unknown;
    if (request.method === "POST") {
      const read = await readJson(request);
      if (read.kind === "too-large") {
        return failureResponse("Automation request is too large.", 413, origin);
      }
      if (read.kind === "invalid") {
        return failureResponse("Automation request is not valid JSON.", 400, origin);
      }
      body = read.value;
    }

    let context: PrincipalRouteContext;
    try {
      context = resolvePrincipalRouteContext({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof ClientPrincipalError) {
        return failureResponse(
          "Automation request is unauthorized.",
          error.category === "invalid" ? 400 : 401,
          origin,
        );
      }
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Automation request is unauthorized.", 401, origin);
      }
      return failureResponse("Automation request is invalid.", 400, origin);
    }

    // A definition is owned by exactly one host; a remote device may only act
    // against its own authenticated host, never a foreign one.
    if (
      context.principal.kind === "remote-device" &&
      String(context.principal.hostId) !== dependencies.hostId
    ) {
      return failureResponse("Automation request is unauthorized.", 401, origin);
    }

    try {
      if (route === "list" && request.method === "GET") {
        return await handleList(dependencies, context, url, origin);
      }
      if (route === "get" && request.method === "GET") {
        return await handleGet(dependencies, context, url, origin);
      }
      if (route === "history" && request.method === "GET") {
        return await handleHistory(dependencies, context, url, origin);
      }
      if (route === "commands" && request.method === "POST") {
        return await handleCommand(dependencies, context, body, origin);
      }
      return failureResponse("Automation request is invalid.", 400, origin);
    } catch {
      return failureResponse("Automation request is invalid.", 400, origin);
    }
  };
}

type AccessibleProjects = ReadonlyMap<string, "chat" | "work" | "code">;

/** Active Projects the authenticated principal can reach right now. */
async function accessibleProjects(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
): Promise<AccessibleProjects> {
  const bootstrap = await dependencies.projects.bootstrap(context.scopeId);
  const accessible = new Map<string, "chat" | "work" | "code">();
  for (const project of bootstrap.active) {
    if (project.lifecycle === "active") accessible.set(String(project.id), project.type);
  }
  return accessible;
}

function isDefinitionAccessible(
  definition: AutomationDefinition,
  accessible: AccessibleProjects,
): boolean {
  return accessible.get(String(definition.projectId)) === definition.mode;
}

async function handleList(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  url: URL,
  origin: string | null,
): Promise<Response> {
  const allowed = new Set(["mode", "projectId", "search", "limit", "cursor"]);
  if (![...url.searchParams.keys()].every((key) => allowed.has(key))) {
    return failureResponse("Automation list request is invalid.", 400, origin);
  }
  const mode = url.searchParams.get("mode") ?? "all";
  if (mode !== "all" && mode !== "work" && mode !== "code") {
    return failureResponse("Automation list mode is invalid.", 400, origin);
  }
  let projectId: ProjectId | undefined;
  if (url.searchParams.has("projectId")) {
    try {
      projectId = decodeProjectId(url.searchParams.get("projectId") ?? "");
    } catch {
      return failureResponse("Automation Project ID is invalid.", 400, origin);
    }
  }
  const limit = parseLimit(url.searchParams.get("limit"), MAX_AUTOMATION_QUERY_LIMIT);
  if (limit === undefined) {
    return failureResponse("Automation list limit is invalid.", 400, origin);
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_AUTOMATION_QUERY_CURSOR_LENGTH) {
    return failureResponse("Automation list cursor is invalid.", 400, origin);
  }
  const search = url.searchParams.get("search") ?? undefined;

  const accessible = await accessibleProjects(dependencies, context);
  if (projectId !== undefined && !accessible.has(String(projectId))) {
    return jsonResponse(
      decodeAutomationQueryResponse({ kind: "automation-list", items: [] }),
      200,
      origin,
    );
  }
  const page = dependencies.projection.listSummaries({
    hostId: dependencies.hostId as HostId,
    mode,
    ...(projectId === undefined ? {} : { projectId }),
    ...(search === undefined ? {} : { search }),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const items = page.items.filter((item) => accessible.get(String(item.projectId)) === item.mode);
  return jsonResponse(
    decodeAutomationQueryResponse({
      kind: "automation-list",
      items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }),
    200,
    origin,
  );
}

async function handleGet(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  url: URL,
  origin: string | null,
): Promise<Response> {
  if (url.searchParams.size !== 1 || !url.searchParams.has("automationId")) {
    return failureResponse("Automation get request is invalid.", 400, origin);
  }
  const automationId = parseAutomationId(url.searchParams.get("automationId"));
  if (automationId === undefined) {
    return failureResponse("Automation ID is invalid.", 400, origin);
  }
  const definition = dependencies.projection.getDefinition(automationId);
  const accessible = await accessibleProjects(dependencies, context);
  // Fail closed with the same not-found for unknown and foreign automations
  // so probes cannot distinguish existence from access.
  if (definition === undefined || !isDefinitionAccessible(definition, accessible)) {
    return failureResponse("Automation is unavailable.", 404, origin);
  }
  const runs = dependencies.projection.listRuns({ automationId, limit: DETAIL_RUNS_LIMIT });
  return jsonResponse(
    decodeAutomationQueryResponse({
      kind: "automation-detail",
      automation: definition,
      runs: runs.runs,
    }),
    200,
    origin,
  );
}

async function handleHistory(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  url: URL,
  origin: string | null,
): Promise<Response> {
  const allowed = new Set(["automationId", "limit", "cursor"]);
  if (
    !url.searchParams.has("automationId") ||
    ![...url.searchParams.keys()].every((key) => allowed.has(key))
  ) {
    return failureResponse("Automation history request is invalid.", 400, origin);
  }
  const automationId = parseAutomationId(url.searchParams.get("automationId"));
  if (automationId === undefined) {
    return failureResponse("Automation ID is invalid.", 400, origin);
  }
  const limit = parseLimit(url.searchParams.get("limit"), MAX_AUTOMATION_HISTORY_ENTRIES);
  if (limit === undefined) {
    return failureResponse("Automation history limit is invalid.", 400, origin);
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && cursor.length > MAX_AUTOMATION_QUERY_CURSOR_LENGTH) {
    return failureResponse("Automation history cursor is invalid.", 400, origin);
  }
  const definition = dependencies.projection.getDefinition(automationId);
  const accessible = await accessibleProjects(dependencies, context);
  if (definition === undefined || !isDefinitionAccessible(definition, accessible)) {
    return failureResponse("Automation is unavailable.", 404, origin);
  }
  const page = dependencies.projection.listRuns({
    automationId,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  return jsonResponse(
    decodeAutomationQueryResponse({
      kind: "automation-history",
      automationId,
      runs: page.runs,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }),
    200,
    origin,
  );
}

async function handleCommand(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  body: unknown,
  origin: string | null,
): Promise<Response> {
  if (!isRecord(body)) {
    return failureResponse("Automation command is invalid.", 400, origin);
  }
  // Identity comes only from the authenticated transport; a body that tries
  // to carry its own principal or origin is rejected outright.
  if ("principal" in body || "origin" in body) {
    return failureResponse("Automation commands cannot supply principal or origin.", 400, origin);
  }

  const accessible = await accessibleProjects(dependencies, context);
  const denial = authorizeCommandProject(dependencies, body, accessible);
  if (denial !== undefined) {
    return jsonResponse(decodeAutomationCommandResult(denial), 200, origin);
  }

  const command = {
    ...body,
    principal: context.principal,
    origin: { kind: "interactive" },
  } as AutomationCommand;
  const result = dependencies.commands.execute(command);
  return jsonResponse(decodeAutomationCommandResult(result), 200, origin);
}

/**
 * Exact-Project authorization for mutations: create must target an accessible
 * Project of the matching mode, and every other command must address an
 * existing Automation whose Project the principal can reach.
 */
function authorizeCommandProject(
  dependencies: AutomationRouteDependencies,
  body: Record<string, unknown>,
  accessible: AccessibleProjects,
): AutomationCommandFailure | undefined {
  if (body["kind"] === "create-automation") {
    const draft = body["definition"];
    if (!isRecord(draft)) return commandFailure("invalid", "Automation draft is malformed.");
    const projectId = draft["projectId"];
    const mode = draft["mode"];
    if (
      typeof projectId !== "string" ||
      typeof mode !== "string" ||
      accessible.get(projectId) !== mode
    ) {
      return commandFailure(
        "unauthorized",
        "Automations can only be created in an accessible Project of the matching mode.",
      );
    }
    return undefined;
  }
  const automationId = body["automationId"];
  if (typeof automationId !== "string") {
    return commandFailure("invalid", "Automation command is missing its Automation ID.");
  }
  const definition = dependencies.projection.getDefinition(automationId as AutomationId);
  if (definition === undefined) {
    return commandFailure("not-found", "Automation does not exist on this host.");
  }
  if (!isDefinitionAccessible(definition, accessible)) {
    return commandFailure(
      "unauthorized",
      "Automation mutations require access to the owning Project.",
      definition.id,
    );
  }
  return undefined;
}

function commandFailure(
  reason: AutomationCommandFailure["reason"],
  message: string,
  automationId?: AutomationId,
): AutomationCommandFailure {
  return {
    kind: "automation-command-failed",
    reason,
    message,
    ...(automationId === undefined ? {} : { automationId }),
  } as AutomationCommandFailure;
}

function parseAutomationId(raw: string | null): AutomationId | undefined {
  try {
    return decodeAutomationId(raw ?? "");
  } catch {
    return undefined;
  }
}

function parseLimit(raw: string | null, max: number): number | undefined {
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  if (!/^\d{1,6}$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) return undefined;
  return value;
}

async function readJson(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(raw)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function jsonResponse(value: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse(
    { category: status === 401 ? "unauthorized" : "invalid", message },
    status,
    origin,
  );
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin === null
    ? {}
    : {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": METHODS,
        "access-control-allow-headers": HEADERS,
      };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
