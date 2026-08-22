import {
  decodeAgentRunControlPreviewRequest,
  decodeAgentRunControlRequest,
  decodeAgentRunCenterQuery,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunResumeRequest,
  decodeAgentRunRetryRequest,
  decodeAgentRunSteerRequest,
  decodeAgentRunWorkspaceConfirmationRequest,
  decodeAgentRunWorkspacePreparationRequest,
  MAX_AGENT_RUN_CENTER_QUERY_LIMIT,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCenterSummary,
  type AgentRunControlRequest,
  type AgentRunCreationRequest,
  type AgentRunId,
  type AgentRunParentThreadId,
  type AgentRunPolicySettings,
  type AgentRunWorkspaceReceipt,
  type AgentRunWorkspaceRefusalReason,
  type AggregateVersion,
  type CodeThreadId,
  type MultiModelPool,
  type OctantMode,
  type ProjectId,
  type ProviderInstanceId,
} from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeProviderInstanceId } from "@octant/contracts/providers";
import {
  assertAgentRunResumeAllowed,
  assertAgentRunRetryAllowed,
  assertAgentRunSteerAllowed,
  AgentRunPolicyRejected,
  type AgentRunNativeCapabilityEvidence,
} from "@octant/domain/agent-run-control-policy";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AgentRunControlRefused,
  buildControlCreationRequest,
  buildControlRequestCommand,
  previewAgentRunControl,
  prepareAdmittedControlWorkspace,
  requestWorkspaceFor,
  resolveAgentRunControlFacts,
  type AgentRunControlParentFacts,
  type AgentRunControlWorkspacePort,
} from "./agentRunControlService";
import {
  AgentRunCreationRejected,
  type AgentRunParentContextPort,
  type AgentRunPoolRoutingContext,
  type ProviderReadinessPort,
} from "./agentRunCreationService";
import {
  AgentRunOrchestrationError,
  type AgentRunOrchestrationService,
} from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";
import type { AgentRunParentSummaryEntry } from "./agentRunProjection";
import {
  clampCenterLimit,
  paginateCenterCandidates,
  workspaceKindForRun,
  type AgentRunCenterCandidate,
} from "./agentRunProjection";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface AgentRunRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly persistence: AgentRunPersistenceService;
  readonly orchestration: AgentRunOrchestrationService;
  readonly settings: { readonly current: () => AgentRunPolicySettings };
  readonly providerReadiness: ProviderReadinessPort;
  /** Resolves the actual parent thread/window authority; client body fields are never authority. */
  readonly authorizeCreation: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly windowId: string;
  }) => AgentRunControlParentFacts | undefined;
  readonly authorizeCancellation: (input: {
    readonly run: AgentRun;
    readonly windowId: string;
  }) => boolean;
  /**
   * Resolve and authorize a parent thread for the authenticated window.
   *
   * A window capability proves the caller is a live renderer of this host; it
   * says nothing about which parent thread's runs that renderer may read. The
   * parent summary carries each completed child's full reply, so without this
   * any renderer that knows or guesses a parent id could read another thread's
   * child answers, and acknowledge could mutate runs the window never owned.
   * Required rather than optional: a host that cannot authorize must not serve
   * AgentRun reads at all.
   */
  readonly authorizeParentThread: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
  /**
   * Server-side gathering of pool routing facts for a child creation request
   * Absent or returning undefined means this host cannot resolve pool
   * routing, so any pool-selecting request fails closed.
   */
  readonly poolRouting?: (input: {
    readonly request: AgentRunCreationRequest;
  }) => AgentRunPoolRoutingContext | undefined | Promise<AgentRunPoolRoutingContext | undefined>;
  /**
   * Server-observed native-child capability evidence. Absent means native
   * execution is ineligible and the child is Octant-managed with a reason.
   */
  readonly nativeEvidence?: (input: {
    readonly parent: AgentRunControlParentFacts;
  }) => AgentRunNativeCapabilityEvidence;
  /**
   * Server-owned child workspace prepare/confirm/admit. Absent means this
   * host cannot issue mode-correct workspace grants, so Work/Code children
   * and explicit Chat receipts fail closed.
   */
  readonly workspace?: AgentRunControlWorkspacePort;
  /**
   * Reads the parent thread's own conversation for a child that asked to be
   * admitted with it. Consulted only after `authorizeCreation` proved this
   * window may create children from that parent thread, so a child can never
   * be admitted with context its parent could not read. Absent means this host
   * admits no parent context, and such a request fails closed.
   */
  readonly parentContext?: AgentRunParentContextPort;
  /**
   * Resolves display facts for one center row after authorization. Parent
   * titles come from this host's thread stores; child thread ids are derived
   * for Code children without inventing filesystem paths.
   */
  readonly resolveCenterContext: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly mode: OctantMode;
  }) => {
    readonly parentThreadTitle: string;
    readonly childThreadId?: CodeThreadId;
  };
  readonly uuid: () => string;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

function refused(
  reason: AgentRunWorkspaceRefusalReason,
  origin: string | null,
  status = 400,
): Response {
  return json({ status: "refused", reason }, status, origin);
}

/**
 * Authenticated AgentRun query/command routes for the shared renderer.
 * Authority and lifecycle remain server-owned; the client only reads summaries
 * and issues acknowledge commands with expected versions.
 */
export function createAgentRunRouteHandler(dependencies: AgentRunRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/agent-runs")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("AgentRun API requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let authenticatedWindowId: string;
    try {
      authenticatedWindowId = String(
        authenticateRouteWindowId({
          request,
          store: dependencies.windowAuthorityStore,
          now: now(),
        }),
      );
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("AgentRun request is unauthorized.", 401, origin);
      }
      return failure("AgentRun request is invalid.", 400, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs/center") {
      return handleCenter(dependencies, authenticatedWindowId, url, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs/parent-summary") {
      let parentThreadId: AgentRunParentThreadId;
      try {
        parentThreadId = decodeAgentRunParentThreadId(url.searchParams.get("parentThreadId") ?? "");
      } catch {
        return failure("parentThreadId is invalid.", 400, origin);
      }
      if (
        !(await dependencies.authorizeParentThread({
          parentThreadId,
          windowId: authenticatedWindowId,
        }))
      ) {
        return failure("AgentRun parent summary is not authorized for this thread.", 403, origin);
      }
      const entries = dependencies.persistence.parentSummary(parentThreadId);
      return json({ parentThreadId, entries: serializeEntries(entries) }, 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/acknowledge") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun acknowledge body is invalid.", 400, origin);
      }
      if (!isRecord(body)) return failure("AgentRun acknowledge body is invalid.", 400, origin);
      let runId: AgentRunId;
      let expectedVersion: number;
      try {
        runId = decodeAgentRunId(body.runId);
        expectedVersion = Number(body.expectedVersion);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          throw new Error("bad version");
        }
      } catch {
        return failure("AgentRun acknowledge fields are invalid.", 400, origin);
      }
      // Authorization derives from the run's own recorded parent thread, never
      // from anything the client claims. An unknown run is refused with the
      // same response, so run ids cannot be probed for existence.
      const acknowledgedRun = dependencies.persistence.getById(runId);
      if (
        acknowledgedRun === undefined ||
        !(await dependencies.authorizeParentThread({
          parentThreadId: acknowledgedRun.parentThreadId,
          windowId: authenticatedWindowId,
        }))
      ) {
        return failure("AgentRun acknowledgement is not authorized for this run.", 403, origin);
      }
      const result = dependencies.persistence.applyCommand({
        kind: "acknowledge-agent-run-result",
        runId,
        expectedVersion: expectedVersion as never,
      });
      return json(result, result.kind === "run-updated" ? 200 : 409, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/workspaces/prepare") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun workspace prepare body is invalid.", 400, origin);
      }
      let prepareRequest: ReturnType<typeof decodeAgentRunWorkspacePreparationRequest>;
      try {
        prepareRequest = decodeAgentRunWorkspacePreparationRequest(body);
      } catch {
        return failure("AgentRun workspace prepare request is invalid.", 400, origin);
      }
      const creationAuthority = dependencies.authorizeCreation({
        parentThreadId: prepareRequest.parentThreadId,
        windowId: authenticatedWindowId,
      });
      if (creationAuthority === undefined) {
        return refused("unauthorized", origin, 403);
      }
      if (dependencies.workspace === undefined) {
        return refused("unavailable", origin);
      }
      const prepared = await dependencies.workspace.prepare({
        windowId: authenticatedWindowId,
        parent: creationAuthority.workspaceParent,
        ...(creationAuthority.codeWorkspace === undefined
          ? {}
          : { code: creationAuthority.codeWorkspace }),
      });
      return json(prepared, prepared.status === "refused" ? 400 : 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/workspaces/confirm") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun workspace confirm body is invalid.", 400, origin);
      }
      let confirmRequest: ReturnType<typeof decodeAgentRunWorkspaceConfirmationRequest>;
      try {
        confirmRequest = decodeAgentRunWorkspaceConfirmationRequest(body);
      } catch {
        return failure("AgentRun workspace confirm request is invalid.", 400, origin);
      }
      const creationAuthority = dependencies.authorizeCreation({
        parentThreadId: confirmRequest.parentThreadId,
        windowId: authenticatedWindowId,
      });
      if (creationAuthority === undefined) {
        return refused("unauthorized", origin, 403);
      }
      if (dependencies.workspace === undefined) {
        return refused("unavailable", origin);
      }
      const confirmed = await dependencies.workspace.confirm({
        windowId: authenticatedWindowId,
        parent: creationAuthority.workspaceParent,
        worktreeReceiptId: String(confirmRequest.worktreeReceiptId),
      });
      return json(confirmed, confirmed.status === "refused" ? 400 : 200, origin);
    }

    if (
      (request.method === "GET" && url.pathname === "/api/agent-runs/control-preview") ||
      (request.method === "POST" && url.pathname === "/api/agent-runs/control-preview")
    ) {
      let previewBody: unknown = {
        parentThreadId: url.searchParams.get("parentThreadId") ?? "",
        ...(url.searchParams.get("role") === null ? {} : { role: url.searchParams.get("role") }),
      };
      if (request.method === "POST") {
        try {
          previewBody = await request.json();
        } catch {
          return failure("AgentRun control preview body is invalid.", 400, origin);
        }
      }
      let previewRequest: ReturnType<typeof decodeAgentRunControlPreviewRequest>;
      try {
        previewRequest = decodeAgentRunControlPreviewRequest(previewBody);
      } catch {
        return failure("AgentRun control preview request is invalid.", 400, origin);
      }
      const creationAuthority = dependencies.authorizeCreation({
        parentThreadId: previewRequest.parentThreadId,
        windowId: authenticatedWindowId,
      });
      if (creationAuthority === undefined) {
        return refused("unauthorized", origin, 403);
      }
      const preview = previewAgentRunControl({
        parent: creationAuthority,
        ...(previewRequest.role === undefined ? {} : { role: previewRequest.role }),
        creationPosture: dependencies.settings.current().creationPosture,
        nativeEvidence: nativeEvidenceFor(dependencies, creationAuthority),
      });
      return json(preview, preview.status === "refused" ? 400 : 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/request") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun request body is invalid.", 400, origin);
      }
      let controlRequest: AgentRunControlRequest;
      try {
        controlRequest = decodeAgentRunControlRequest(body);
      } catch {
        return failure("AgentRun creation request is invalid.", 400, origin);
      }
      const posture = dependencies.settings.current().creationPosture;
      const creationAuthority = dependencies.authorizeCreation({
        parentThreadId: controlRequest.parentThreadId,
        windowId: authenticatedWindowId,
      });
      if (creationAuthority === undefined) {
        return refused("unauthorized", origin, 403);
      }
      const nativeEvidence = nativeEvidenceFor(dependencies, creationAuthority);
      try {
        resolveAgentRunControlFacts({
          parent: creationAuthority,
          role: controlRequest.role,
          creationPosture: posture,
          nativeEvidence,
        });
      } catch (error) {
        if (error instanceof AgentRunControlRefused) {
          return refused(error.reason, origin);
        }
        throw error;
      }
      // Return an idempotent receipt before mutable provider readiness is
      // consulted. The receipt is only reusable for the exact authorized
      // request; an opaque request ID cannot be used to read or start another
      // thread's child.
      const existing = dependencies.persistence.getByRequestId(controlRequest.requestId);
      if (existing !== undefined) {
        if (!matchesIdempotentControlRequest(existing, controlRequest, creationAuthority)) {
          return failure(
            "AgentRun request ID cannot be reused for a different authorized request.",
            409,
            origin,
          );
        }
        return respondAfterAdmission(
          existing,
          dependencies.orchestration,
          creationAuthority.liveAuthority,
          origin,
        );
      }
      let admittedWorkspace: AgentRunWorkspaceReceipt | undefined;
      if (dependencies.workspace !== undefined) {
        const admitted = await prepareAdmittedControlWorkspace({
          windowId: authenticatedWindowId,
          parent: creationAuthority,
          role: controlRequest.role,
          workspace: dependencies.workspace,
        });
        if (admitted.status === "refused") {
          return refused(admitted.reason, origin);
        }
        admittedWorkspace = admitted.workspace;
      } else if (creationAuthority.parentMode === "chat") {
        admittedWorkspace = { kind: "chat-virtual", mode: "chat" };
      } else {
        return refused("unavailable", origin);
      }
      let command: ReturnType<typeof buildControlRequestCommand>;
      try {
        const facts = resolveAgentRunControlFacts({
          parent: creationAuthority,
          role: controlRequest.role,
          creationPosture: posture,
          nativeEvidence,
        });
        const creationRequest = buildControlCreationRequest({
          control: controlRequest,
          facts,
          workspace: requestWorkspaceFor(admittedWorkspace),
        });
        const poolRoutingContext =
          controlRequest.pool === undefined
            ? undefined
            : await dependencies.poolRouting?.({ request: creationRequest });
        command = buildControlRequestCommand({
          control: controlRequest,
          parent: creationAuthority,
          creationPosture: posture,
          nativeEvidence,
          admittedWorkspace,
          providerReadiness: dependencies.providerReadiness,
          uuid: dependencies.uuid,
          ...(poolRoutingContext === undefined ? {} : { poolRouting: poolRoutingContext }),
          ...(dependencies.parentContext === undefined
            ? {}
            : { parentContext: dependencies.parentContext }),
        });
      } catch (error) {
        if (error instanceof AgentRunControlRefused) {
          return refused(error.reason, origin);
        }
        if (error instanceof AgentRunCreationRejected) {
          if (isWorkspaceRefusal(error.reason)) {
            return refused(error.reason, origin);
          }
          return failure(error.message, 400, origin);
        }
        throw error;
      }
      try {
        const result = dependencies.orchestration.admit({
          command,
          parentAuthority: creationAuthority.parentAuthority,
          liveAuthority: creationAuthority.liveAuthority,
          // Posture Off is still rejected by domain policy below; Ask and
          // Automatic are both reached only through this explicit,
          // human-initiated creation route, so the act of calling it is the
          // approval Ask requires.
          confirmed: posture !== "off",
        });
        return respondAfterAdmission(
          result,
          dependencies.orchestration,
          creationAuthority.liveAuthority,
          origin,
        );
      } catch (error) {
        if (error instanceof AgentRunOrchestrationError) {
          if (error.reason === "workspace-denied") {
            return refused(
              error.message.includes("parent checkout")
                ? "parent-checkout"
                : error.message.includes("binding")
                  ? "stale"
                  : "unavailable",
              origin,
            );
          }
          return failure(error.message, 400, origin);
        }
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/cancel") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun cancel body is invalid.", 400, origin);
      }
      if (!isRecord(body)) return failure("AgentRun cancel body is invalid.", 400, origin);
      let runId: AgentRunId;
      try {
        runId = decodeAgentRunId(body.runId);
      } catch {
        return failure("AgentRun cancel runId is invalid.", 400, origin);
      }
      const scope = body.scope;
      if (scope !== "self" && scope !== "subtree" && scope !== "hierarchy") {
        return failure("AgentRun cancel scope is invalid.", 400, origin);
      }
      const targets = dependencies.orchestration.cancellationTargets({ runId, scope });
      if (
        targets.length === 0 ||
        targets.some(
          (run) => !dependencies.authorizeCancellation({ run, windowId: authenticatedWindowId }),
        )
      ) {
        return failure("AgentRun cancellation is unauthorized.", 403, origin);
      }
      const results = await dependencies.orchestration.cancelLeafFirst({ runId, scope });
      const status = results.some((result) => result.kind === "run-command-failed") ? 409 : 200;
      return json({ results }, status, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/agent-runs/steer") {
      return mutateLiveRun(request, origin, authenticatedWindowId, dependencies, "steer");
    }
    if (request.method === "POST" && url.pathname === "/api/agent-runs/retry") {
      return mutateLiveRun(request, origin, authenticatedWindowId, dependencies, "retry");
    }
    if (request.method === "POST" && url.pathname === "/api/agent-runs/resume") {
      return mutateLiveRun(request, origin, authenticatedWindowId, dependencies, "resume");
    }

    return failure("AgentRun route not found.", 404, origin);
  };
}

async function handleCenter(
  dependencies: AgentRunRouteDependencies,
  windowId: string,
  url: URL,
  origin: string | null,
): Promise<Response> {
  const allowed = new Set([
    "status",
    "mode",
    "projectId",
    "providerInstanceId",
    "parentThreadId",
    "search",
    "limit",
    "cursor",
  ]);
  if (![...url.searchParams.keys()].every((key) => allowed.has(key))) {
    return failure("AgentRun center query is invalid.", 400, origin);
  }
  const status = url.searchParams.get("status") ?? "all";
  if (status !== "all" && status !== "active" && status !== "history") {
    return failure("AgentRun center status filter is invalid.", 400, origin);
  }
  const mode = url.searchParams.get("mode") ?? "all";
  if (mode !== "all" && mode !== "chat" && mode !== "work" && mode !== "code") {
    return failure("AgentRun center mode filter is invalid.", 400, origin);
  }
  let projectId: ProjectId | undefined;
  if (url.searchParams.has("projectId")) {
    try {
      projectId = decodeProjectId(url.searchParams.get("projectId") ?? "");
    } catch {
      return failure("AgentRun center Project ID is invalid.", 400, origin);
    }
  }
  let providerInstanceId: ProviderInstanceId | undefined;
  if (url.searchParams.has("providerInstanceId")) {
    try {
      providerInstanceId = decodeProviderInstanceId(
        url.searchParams.get("providerInstanceId") ?? "",
      );
    } catch {
      return failure("AgentRun center provider instance ID is invalid.", 400, origin);
    }
  }
  let parentThreadId: AgentRunParentThreadId | undefined;
  if (url.searchParams.has("parentThreadId")) {
    try {
      parentThreadId = decodeAgentRunParentThreadId(url.searchParams.get("parentThreadId") ?? "");
    } catch {
      return failure("AgentRun center parent thread ID is invalid.", 400, origin);
    }
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = clampCenterLimit(
    rawLimit === null ? MAX_AGENT_RUN_CENTER_QUERY_LIMIT : Number(rawLimit),
    MAX_AGENT_RUN_CENTER_QUERY_LIMIT,
  );
  if (rawLimit !== null && !Number.isSafeInteger(Number(rawLimit))) {
    return failure("AgentRun center limit is invalid.", 400, origin);
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  let query;
  try {
    query = decodeAgentRunCenterQuery({
      status,
      mode,
      ...(projectId === undefined ? {} : { projectId }),
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(search === undefined || search.trim().length === 0 ? {} : { search: search.trim() }),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
  } catch {
    return failure("AgentRun center query is invalid.", 400, origin);
  }

  const candidates = dependencies.persistence.listCenterCandidates({
    status: query.status,
    mode: query.mode,
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
    ...(query.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: query.providerInstanceId }),
    ...(query.parentThreadId === undefined ? {} : { parentThreadId: query.parentThreadId }),
    ...(query.search === undefined ? {} : { search: query.search }),
  });
  const authorized: AgentRunCenterCandidate[] = [];
  for (const candidate of candidates) {
    if (
      await dependencies.authorizeParentThread({
        parentThreadId: candidate.run.parentThreadId,
        windowId,
      })
    ) {
      authorized.push(candidate);
    }
  }
  const page = paginateCenterCandidates(authorized, query.limit, query.cursor);
  const items = page.items.map((candidate) =>
    serializeCenterSummary(candidate, dependencies.resolveCenterContext),
  );
  return json(
    {
      items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
    200,
    origin,
  );
}

function serializeCenterSummary(
  candidate: AgentRunCenterCandidate,
  resolveCenterContext: AgentRunRouteDependencies["resolveCenterContext"],
): AgentRunCenterSummary {
  const { run, route } = candidate;
  const context = resolveCenterContext({
    parentThreadId: run.parentThreadId,
    mode: run.routingReceipt.mode,
  });
  return {
    runId: run.id,
    requestId: run.requestId,
    parentThreadId: run.parentThreadId,
    parentThreadTitle: context.parentThreadTitle,
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    ...(context.childThreadId === undefined ? {} : { childThreadId: context.childThreadId }),
    mode: run.routingReceipt.mode,
    ...(run.routingReceipt.projectId === undefined
      ? {}
      : { projectId: run.routingReceipt.projectId }),
    role: run.role,
    task: run.task,
    lifecycleStatus: run.lifecycleStatus,
    executionKind: run.executionKind,
    authority: run.authority,
    workspaceKind: workspaceKindForRun(run),
    usageQuality: run.routingReceipt.usageQuality,
    route,
    resultAcknowledgement: run.resultAcknowledgement,
    ...(run.recoveryReason === undefined ? {} : { recoveryReason: run.recoveryReason }),
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function respondAfterAdmission(
  result: ReturnType<AgentRunOrchestrationService["admit"]> | AgentRun,
  orchestration: AgentRunOrchestrationService,
  liveAuthority: AgentRunAuthority,
  origin: string | null,
): Response {
  const accepted = "kind" in result ? result : { kind: "run-accepted" as const, run: result };
  if (
    accepted.kind === "run-accepted" &&
    accepted.run.lifecycleStatus === "queued" &&
    accepted.run.recoveryReason === undefined
  ) {
    const started = orchestration.start(accepted.run.id, accepted.run.version, liveAuthority);
    return json(started, started.kind === "run-command-failed" ? 409 : 200, origin);
  }
  // A `run-updated` admission (e.g. a pool child durably Waiting on its
  // immutable route decision) is a success, not a conflict.
  return json(accepted, accepted.kind === "run-command-failed" ? 409 : 200, origin);
}

function matchesIdempotentControlRequest(
  existing: AgentRun,
  request: AgentRunControlRequest,
  parent: AgentRunControlParentFacts,
): boolean {
  return (
    existing.parentThreadId === request.parentThreadId &&
    existing.parentRunId === request.parentRunId &&
    existing.role === request.role &&
    existing.task === request.task &&
    existing.routingReceipt.mode === parent.parentMode &&
    existing.routingReceipt.selectedProviderInstanceId === parent.parentRoute.providerInstanceId &&
    existing.routingReceipt.selectedModelId === parent.parentRoute.modelId &&
    existing.routingReceipt.rawReasoning === parent.parentRoute.reasoning &&
    matchesIdempotentPool(existing.routingReceipt.poolRoute?.decision.request.pool, request.pool) &&
    (existing.routingReceipt.admittedContextBlocks !== undefined) ===
      (request.includeParentContext === true) &&
    authorityIsWithin(existing.authority, parent.parentAuthority) &&
    authorityIsWithin(existing.authority, parent.liveAuthority)
  );
}

function nativeEvidenceFor(
  dependencies: AgentRunRouteDependencies,
  parent: AgentRunControlParentFacts,
): AgentRunNativeCapabilityEvidence {
  return (
    dependencies.nativeEvidence?.({ parent }) ?? {
      claimedNativeSupport: "unsupported",
      workspace: false,
      authority: false,
      observability: false,
      cancellation: false,
      steering: false,
      recovery: false,
    }
  );
}

async function mutateLiveRun(
  request: Request,
  origin: string | null,
  windowId: string,
  dependencies: AgentRunRouteDependencies,
  action: "steer" | "retry" | "resume",
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(`AgentRun ${action} body is invalid.`, 400, origin);
  }
  let runId: AgentRunId;
  let expectedVersion: number;
  let message: string | undefined;
  try {
    if (action === "steer") {
      const decoded = decodeAgentRunSteerRequest(body);
      runId = decoded.runId;
      expectedVersion = decoded.expectedVersion;
      message = decoded.message;
    } else if (action === "retry") {
      const decoded = decodeAgentRunRetryRequest(body);
      runId = decoded.runId;
      expectedVersion = decoded.expectedVersion;
    } else {
      const decoded = decodeAgentRunResumeRequest(body);
      runId = decoded.runId;
      expectedVersion = decoded.expectedVersion;
    }
  } catch {
    return failure(`AgentRun ${action} fields are invalid.`, 400, origin);
  }
  const run = dependencies.persistence.getById(runId);
  if (
    run === undefined ||
    !(await dependencies.authorizeParentThread({
      parentThreadId: run.parentThreadId,
      windowId,
    }))
  ) {
    return failure(`AgentRun ${action} is not authorized for this run.`, 403, origin);
  }
  try {
    if (action === "steer") {
      assertAgentRunSteerAllowed(run, expectedVersion as AggregateVersion);
    } else if (action === "retry") {
      assertAgentRunRetryAllowed(run, expectedVersion as AggregateVersion);
    } else {
      assertAgentRunResumeAllowed(run, expectedVersion as AggregateVersion);
    }
  } catch (error) {
    if (error instanceof AgentRunPolicyRejected) {
      return json(
        {
          kind: "run-command-failed",
          reason: error.code === "stale-version" ? "stale-version" : "unsupported-transition",
          message: error.message,
        },
        error.code === "stale-version" ? 409 : 400,
        origin,
      );
    }
    throw error;
  }
  const parent = dependencies.authorizeCreation({
    parentThreadId: run.parentThreadId,
    windowId,
  });
  if (parent === undefined) {
    return failure(`AgentRun ${action} is not authorized for this run.`, 403, origin);
  }
  if (action === "steer") {
    const result = await dependencies.orchestration.steer({
      runId,
      expectedVersion,
      message: message ?? "",
    });
    return json(result, result.kind === "run-command-failed" ? 409 : 200, origin);
  }
  const result =
    action === "retry"
      ? dependencies.orchestration.retry(runId, expectedVersion, parent.liveAuthority)
      : dependencies.orchestration.resume(runId, expectedVersion, parent.liveAuthority);
  return json(result, result.kind === "run-command-failed" ? 409 : 200, origin);
}

/**
 * A retried request ID must carry the exact pool (or absence of one) that the
 * stored immutable route was decided from; otherwise the receipt would claim
 * a decision the caller never requested.
 */
function matchesIdempotentPool(
  decided: MultiModelPool | undefined,
  requested: MultiModelPool | undefined,
): boolean {
  if (decided === undefined || requested === undefined) {
    return decided === undefined && requested === undefined;
  }
  return (
    decided.mixedVendorEnabled === requested.mixedVendorEnabled &&
    decided.fallbackAllowed === requested.fallbackAllowed &&
    decided.higherCostFallbackAllowed === requested.higherCostFallbackAllowed &&
    decided.candidates.length === requested.candidates.length &&
    decided.candidates.every(
      (candidate, index) =>
        String(candidate.hostId) === String(requested.candidates[index]!.hostId) &&
        candidate.providerInstanceId === requested.candidates[index]!.providerInstanceId &&
        candidate.modelId === requested.candidates[index]!.modelId,
    )
  );
}

function authorityIsWithin(effective: AgentRunAuthority, ceiling: AgentRunAuthority): boolean {
  const booleanKeys = ["filesystem", "shell", "git", "network", "tools", "subagents"] as const;
  if (booleanKeys.some((key) => effective[key] && !ceiling[key])) return false;
  const executionRank: Record<AgentRunAuthority["executionPolicy"], number> = {
    plan: 0,
    "approval-gated": 1,
    "auto-accept-edits": 2,
    "full-access": 3,
  };
  return (
    executionRank[effective.executionPolicy] <= executionRank[ceiling.executionPolicy] &&
    (effective.permissionPersistence !== "project-default" ||
      ceiling.permissionPersistence === "project-default")
  );
}

function serializeEntries(entries: ReadonlyArray<AgentRunParentSummaryEntry>) {
  return entries.map((entry) => ({
    runId: entry.runId,
    requestId: entry.requestId,
    parentThreadId: entry.parentThreadId,
    ...(entry.parentRunId === undefined ? {} : { parentRunId: entry.parentRunId }),
    role: entry.role,
    task: entry.task,
    lifecycleStatus: entry.lifecycleStatus,
    executionKind: entry.executionKind,
    usageQuality: entry.usageQuality,
    route: entry.route,
    resultAcknowledgement: entry.resultAcknowledgement,
    // The completed child's reply travels with the run it belongs to, and the
    // route refuses the summary before this serializer runs unless the window
    // is authorized for the parent thread — so the reply is readable by
    // exactly what may read this parent thread's runs. A reply purged with a
    // deleted parent thread leaves its identity here without text, so a reader
    // is told it is gone rather than handed an empty one.
    ...(entry.result === undefined
      ? {}
      : {
          result: {
            ...entry.result,
            ...(entry.resultText === undefined ? {} : { text: entry.resultText }),
          },
        }),
    ...(entry.recoveryReason === undefined ? {} : { recoveryReason: entry.recoveryReason }),
    version: entry.version,
    updatedAt: entry.updatedAt,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceRefusal(reason: string): reason is AgentRunWorkspaceRefusalReason {
  return (
    reason === "unauthorized" ||
    reason === "unavailable" ||
    reason === "stale" ||
    reason === "expired" ||
    reason === "foreign-thread" ||
    reason === "foreign-project" ||
    reason === "parent-checkout" ||
    reason === "wider-than-parent" ||
    reason === "unconfirmed" ||
    reason === "unsupported"
  );
}
