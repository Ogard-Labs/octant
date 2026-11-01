import { randomUUID } from "node:crypto";
import {
  decodeAutomationCommandResult,
  decodeAutomationFollowUpRequest,
  decodeAutomationThreadRoutineRequest,
  decodeAutomationTrigger,
  decodeRoutineProposalDecision,
  decodeRoutineProposalId,
  decodeRoutineProposalDecisionResult,
  decodeRoutineProposalList,
  decodeAutomationId,
  decodeAutomationQueryResponse,
  decodeProjectId,
  MAX_AUTOMATION_HISTORY_ENTRIES,
  MAX_AUTOMATION_QUERY_CURSOR_LENGTH,
  MAX_AUTOMATION_QUERY_LIMIT,
  type AutomationCommand,
  type AutomationCommandFailure,
  type AutomationCommandResult,
  type AutomationDefinition,
  type AutomationId,
  type HostId,
  type ProjectId,
  type RoutineProposal,
  type UtcTimestamp,
} from "@octant/contracts";
import { resolveNextAutomationOccurrence } from "@octant/domain";
import { ClientPrincipalError } from "../clientPrincipal";
import { resolvePrincipalRouteContext, type PrincipalRouteContext } from "../principalRouteContext";
import type { ProjectService } from "../projectService";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { AutomationCommandService } from "./automationCommandService";
import type { AutomationProjection } from "./automationProjection";
import type { RoutineProposalService } from "./routineProposalService";
import type { ThreadRoutineDraftResult } from "./threadRoutineDraft";

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
  /**
   * False when start-up could not rebuild Automation history. The list then
   * says so instead of reading as empty, and commands are refused rather than
   * written against history the host never loaded.
   */
  readonly historyAvailable?: () => boolean;
  /**
   * Routines thread agents proposed. Listed and answered only by the window
   * whose turn raised them; a confirm builds the routine from the thread's
   * live facts and creates it through the same command path as `commands`.
   */
  readonly proposals?: {
    readonly service: Pick<RoutineProposalService, "list" | "claim">;
    readonly draft: (proposal: RoutineProposal) => ThreadRoutineDraftResult;
  };
  readonly now?: () => number;
  readonly uuid?: () => string;
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
      if (route === "proposals" && request.method === "GET") {
        return jsonResponse(
          decodeRoutineProposalList({
            kind: "routine-proposal-list",
            proposals: dependencies.proposals?.service.list(context.scopeId) ?? [],
          }),
          200,
          origin,
        );
      }
      if (route === "proposals/decide" && request.method === "POST") {
        return await handleProposalDecision(dependencies, context, body, origin);
      }
      if (route === "follow-ups" && request.method === "POST") {
        return await handleFollowUp(dependencies, context, body, origin);
      }
      if (route === "thread-routines" && request.method === "POST") {
        return await handleThreadRoutine(dependencies, context, body, origin);
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
  if (mode !== "all" && mode !== "chat" && mode !== "work" && mode !== "code") {
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

  if (dependencies.historyAvailable?.() === false) {
    return jsonResponse(
      decodeAutomationQueryResponse({
        kind: "automation-list",
        items: [],
        historyUnavailable: true,
      }),
      200,
      origin,
    );
  }
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

  if (dependencies.historyAvailable?.() === false) {
    return jsonResponse(
      decodeAutomationCommandResult({
        kind: "automation-command-failed",
        reason: "unsupported",
        message: "Automation history could not be loaded, so Automations cannot change.",
      }),
      200,
      origin,
    );
  }
  // Running a routine at its Project's level, or at a level picked on the
  // routine, can mean Full access with nobody watching, and Full access is
  // chosen at a window on this host, so a paired device cannot set either.
  if (
    context.principal.kind === "remote-device" &&
    (body.kind === "create-automation" || body.kind === "update-automation") &&
    isRecord(body.definition) &&
    (body.definition.projectLevel !== undefined || body.definition.runLevel !== undefined)
  ) {
    return jsonResponse(
      decodeAutomationCommandResult({
        kind: "automation-command-failed",
        reason: "unauthorized",
        message: "A routine's level is chosen in the Octant window on this host.",
      }),
      200,
      origin,
    );
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
 * A person's answer to a thread's routine proposal. The proposal leaves the
 * waiting list on the first answer, so a retry cannot create a second
 * routine. A confirm is a create by this request's own principal, held to the
 * same Project check and command service as a create from the editor; only
 * the host adds which thread proposed it.
 */
async function handleProposalDecision(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  body: unknown,
  origin: string | null,
): Promise<Response> {
  const proposals = dependencies.proposals;
  let decision;
  try {
    decision = decodeRoutineProposalDecision(body);
  } catch {
    return failureResponse("Routine proposal decision is invalid.", 400, origin);
  }
  const claimed = proposals?.service.claim(context.scopeId, decision.proposalId);
  if (proposals === undefined || claimed === undefined) {
    return jsonResponse(
      decodeRoutineProposalDecisionResult({ kind: "routine-proposal-gone" }),
      200,
      origin,
    );
  }
  if (decision.decision === "decline") {
    claimed.settle({ status: "declined" });
    return jsonResponse(
      decodeRoutineProposalDecisionResult({ kind: "routine-proposal-declined" }),
      200,
      origin,
    );
  }
  const refuse = (failure: AutomationCommandFailure): Response => {
    claimed.settle({ status: "not-created", message: failure.message });
    return jsonResponse(decodeRoutineProposalDecisionResult(failure), 200, origin);
  };
  const result = await createThreadRoutine(dependencies, context, claimed.proposal);
  if (result.kind !== "automation-created") {
    return refuse(
      result.kind === "automation-command-failed"
        ? result
        : commandFailure("invalid", "The routine was not created."),
    );
  }
  claimed.settle({ status: "confirmed", automationId: result.automation.id });
  return jsonResponse(
    decodeRoutineProposalDecisionResult({
      kind: "routine-proposal-confirmed",
      automation: result.automation,
    }),
    200,
    origin,
  );
}

/**
 * Create the routine a thread asked for, as this request's own principal:
 * the definition is built from the thread's live facts, held to the same
 * Project check and command service as a create from the editor, and only
 * the host records which thread it came from.
 */
async function createThreadRoutine(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  proposal: RoutineProposal,
): Promise<AutomationCommandResult> {
  if (dependencies.historyAvailable?.() === false) {
    return commandFailure(
      "unsupported",
      "Automation history could not be loaded, so Automations cannot change.",
    );
  }
  if (dependencies.proposals === undefined) {
    return commandFailure("unsupported", "Routines from a thread are unavailable on this host.");
  }
  const built = dependencies.proposals.draft(proposal);
  if (built.status === "refused") return commandFailure("invalid", built.message);
  const create = {
    kind: "create-automation",
    automationId: decodeAutomationId((dependencies.uuid ?? randomUUID)()),
    expectedVersion: 0,
    definition: built.draft,
  };
  const accessible = await accessibleProjects(dependencies, context);
  const denial = authorizeCommandProject(dependencies, create, accessible);
  if (denial !== undefined) return denial;
  return dependencies.commands.execute(
    {
      ...create,
      principal: context.principal,
      origin: { kind: "interactive" },
    } as AutomationCommand,
    { originThreadId: proposal.threadId },
  );
}

/**
 * A person creating a routine from a thread's Environment: the same draft
 * from the thread's live facts and the same create as a confirmed proposal,
 * so its Project, mode, and authority are the thread's, never the body's.
 */
async function handleThreadRoutine(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  body: unknown,
  origin: string | null,
): Promise<Response> {
  let request;
  try {
    request = decodeAutomationThreadRoutineRequest(body);
  } catch {
    return failureResponse("Routine request is invalid.", 400, origin);
  }
  const now = new Date((dependencies.now ?? Date.now)()).toISOString() as UtcTimestamp;
  const firstRunAt = resolveNextAutomationOccurrence({
    trigger: request.trigger,
    after: now,
    inclusive: false,
  });
  if (firstRunAt === undefined) {
    return jsonResponse(
      decodeAutomationCommandResult(
        commandFailure("invalid", "That schedule never runs after now."),
      ),
      200,
      origin,
    );
  }
  const result = await createThreadRoutine(dependencies, context, {
    proposalId: decodeRoutineProposalId((dependencies.uuid ?? randomUUID)()),
    threadId: request.threadId,
    mode: request.mode,
    projectId: request.projectId,
    displayName: request.displayName,
    taskPrompt: request.taskPrompt,
    trigger: request.trigger,
    missedRunPolicy: request.missedRunPolicy,
    firstRunAt,
    requestedAt: now,
  });
  return jsonResponse(decodeAutomationCommandResult(result), 200, origin);
}

/** The plain name a follow-up a person set up from the thread goes by. */
const FOLLOW_UP_DISPLAY_NAME = "Follow up";

/**
 * A person setting up or moving a follow-up from the thread. Setting one up
 * is a confirmed proposal in all but name: the same draft from the thread's
 * live facts, the same create. Moving one is an ordinary update of its time,
 * held to the same Project check as any edit.
 */
async function handleFollowUp(
  dependencies: AutomationRouteDependencies,
  context: PrincipalRouteContext,
  body: unknown,
  origin: string | null,
): Promise<Response> {
  let request;
  try {
    request = decodeAutomationFollowUpRequest(body);
  } catch {
    return failureResponse("Follow-up request is invalid.", 400, origin);
  }
  const nowMs = (dependencies.now ?? Date.now)();
  if (Date.parse(request.scheduledAt) <= nowMs) {
    return jsonResponse(
      decodeAutomationCommandResult(commandFailure("invalid", "Pick a time in the future.")),
      200,
      origin,
    );
  }
  const trigger = decodeAutomationTrigger({ kind: "once", scheduledAt: request.scheduledAt });
  if (request.kind === "schedule-follow-up") {
    const result = await createThreadRoutine(dependencies, context, {
      proposalId: decodeRoutineProposalId((dependencies.uuid ?? randomUUID)()),
      threadId: request.threadId,
      mode: request.mode,
      projectId: request.projectId,
      displayName: FOLLOW_UP_DISPLAY_NAME,
      taskPrompt: request.taskPrompt,
      trigger,
      missedRunPolicy: "run-once",
      targetPolicy: "same-thread",
      firstRunAt: request.scheduledAt,
      requestedAt: new Date(nowMs).toISOString() as RoutineProposal["requestedAt"],
    });
    return jsonResponse(decodeAutomationCommandResult(result), 200, origin);
  }
  if (dependencies.historyAvailable?.() === false) {
    return jsonResponse(
      decodeAutomationCommandResult(
        commandFailure(
          "unsupported",
          "Automation history could not be loaded, so Automations cannot change.",
        ),
      ),
      200,
      origin,
    );
  }
  const current = dependencies.projection.getDefinition(request.automationId);
  if (current === undefined || current.targetPolicy !== "same-thread") {
    return jsonResponse(
      decodeAutomationCommandResult(commandFailure("not-found", "That follow-up is gone.")),
      200,
      origin,
    );
  }
  const update = {
    kind: "update-automation",
    automationId: current.id,
    expectedVersion: request.expectedVersion,
    definition: {
      displayName: current.displayName,
      taskPrompt: current.taskPrompt,
      hostId: current.hostId,
      mode: current.mode,
      projectId: current.projectId,
      projectVersion: current.projectVersion,
      binding: current.binding,
      executionProfile: current.executionProfile,
      authorityProfile: current.authorityProfile,
      deliveryTarget: current.deliveryTarget,
      trigger,
      missedRunPolicy: current.missedRunPolicy,
      targetPolicy: current.targetPolicy,
    },
  };
  const accessible = await accessibleProjects(dependencies, context);
  const denial = authorizeCommandProject(dependencies, update, accessible);
  if (denial !== undefined) {
    return jsonResponse(decodeAutomationCommandResult(denial), 200, origin);
  }
  const result = dependencies.commands.execute({
    ...update,
    principal: context.principal,
    origin: { kind: "interactive" },
  } as AutomationCommand);
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
