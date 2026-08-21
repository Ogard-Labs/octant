import {
  decodeAgentRunCreationRequest,
  decodeAgentRunId,
  decodeAgentRunParentThreadId,
  decodeAgentRunWorkspaceConfirmationRequest,
  decodeAgentRunWorkspacePreparationRequest,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCreationRequest,
  type AgentRunId,
  type AgentRunParentThreadId,
  type AgentRunPolicySettings,
  type AgentRunWorkspaceConfirmationResult,
  type AgentRunWorkspacePreparationResult,
  type AgentRunWorkspaceReceipt,
  type AgentRunWorkspaceRefusalReason,
  type MultiModelPool,
} from "@octant/contracts";
import type { AgentRunWorkspaceParentFacts } from "@octant/domain/agent-run-workspace-policy";
import type { AgentRunCodeWorkspaceContext } from "./agentRunWorkspaceService";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  AgentRunCreationRejected,
  agentRunRequestAuthorityDigest,
  buildAgentRunRequestCommand,
  type AgentRunParentContextPort,
  type AgentRunPoolRoutingContext,
  type AgentRunWorktreeReceiptPort,
  type ProviderReadinessPort,
} from "./agentRunCreationService";
import {
  AgentRunOrchestrationError,
  type AgentRunOrchestrationService,
} from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";
import type { AgentRunParentSummaryEntry } from "./agentRunProjection";

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
  }) =>
    | {
        readonly parentMode: "chat" | "work" | "code";
        readonly parentAuthority: AgentRunAuthority;
        readonly liveAuthority: AgentRunAuthority;
        readonly workspaceParent: AgentRunWorkspaceParentFacts;
        readonly codeWorkspace?: AgentRunCodeWorkspaceContext;
      }
    | undefined;
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
   * Resolves a verified Code worktree receipt for child creation. Absent means
   * this host cannot admit Code children.
   */
  readonly resolveCodeWorktreeReceipt?: (input: {
    readonly request: AgentRunCreationRequest;
  }) => AgentRunWorktreeReceiptPort | undefined | Promise<AgentRunWorktreeReceiptPort | undefined>;
  /**
   * Server-owned child workspace prepare/confirm/admit. Absent means this
   * host cannot issue mode-correct workspace grants, so Work/Code children
   * and explicit Chat receipts fail closed.
   */
  readonly workspace?: {
    readonly prepare: (input: {
      readonly windowId: string;
      readonly parent: AgentRunWorkspaceParentFacts;
      readonly code?: AgentRunCodeWorkspaceContext;
    }) => Promise<AgentRunWorkspacePreparationResult>;
    readonly confirm: (input: {
      readonly windowId: string;
      readonly parent: AgentRunWorkspaceParentFacts;
      readonly worktreeReceiptId: string;
    }) => Promise<AgentRunWorkspaceConfirmationResult>;
    readonly admit: (input: {
      readonly windowId: string;
      readonly requested: AgentRunCreationRequest["workspace"];
      readonly role: AgentRunCreationRequest["role"];
      readonly parent: AgentRunWorkspaceParentFacts;
    }) => Promise<
      | { readonly status: "admitted"; readonly workspace: AgentRunWorkspaceReceipt }
      | { readonly status: "refused"; readonly reason: AgentRunWorkspaceRefusalReason }
    >;
  };
  /**
   * Reads the parent thread's own conversation for a child that asked to be
   * admitted with it. Consulted only after `authorizeCreation` proved this
   * window may create children from that parent thread, so a child can never
   * be admitted with context its parent could not read. Absent means this host
   * admits no parent context, and such a request fails closed.
   */
  readonly parentContext?: AgentRunParentContextPort;
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

    if (request.method === "POST" && url.pathname === "/api/agent-runs/request") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun request body is invalid.", 400, origin);
      }
      let creationRequest: ReturnType<typeof decodeAgentRunCreationRequest>;
      try {
        creationRequest = decodeAgentRunCreationRequest(body);
      } catch {
        return failure("AgentRun creation request is invalid.", 400, origin);
      }
      const posture = dependencies.settings.current().creationPosture;
      const creationAuthority = dependencies.authorizeCreation({
        parentThreadId: creationRequest.parentThreadId,
        windowId: authenticatedWindowId,
      });
      if (creationAuthority === undefined) {
        return refused("unauthorized", origin, 403);
      }
      if (creationRequest.mode !== creationAuthority.parentMode) {
        return refused("unsupported", origin);
      }
      // Return an idempotent receipt before mutable provider readiness is
      // consulted. The receipt is only reusable for the exact authorized
      // request; an opaque request ID cannot be used to read or start another
      // thread's child.
      const existing = dependencies.persistence.getByRequestId(creationRequest.requestId);
      if (existing !== undefined) {
        if (!matchesIdempotentCreationRequest(existing, creationRequest, creationAuthority)) {
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
      const poolRoutingContext =
        creationRequest.pool === undefined
          ? undefined
          : await dependencies.poolRouting?.({ request: creationRequest });
      const worktreeReceipts =
        creationRequest.workspace.kind === "code-worktree"
          ? await dependencies.resolveCodeWorktreeReceipt?.({ request: creationRequest })
          : undefined;
      let admittedWorkspace: AgentRunWorkspaceReceipt | undefined;
      if (dependencies.workspace !== undefined) {
        const admitted = await dependencies.workspace.admit({
          windowId: authenticatedWindowId,
          requested: creationRequest.workspace,
          role: creationRequest.role,
          parent: creationAuthority.workspaceParent,
        });
        if (admitted.status === "refused") {
          return refused(admitted.reason, origin);
        }
        admittedWorkspace = admitted.workspace;
      } else if (creationRequest.mode === "work") {
        return refused("unavailable", origin);
      }
      let command: ReturnType<typeof buildAgentRunRequestCommand>;
      try {
        command = buildAgentRunRequestCommand({
          request: creationRequest,
          creationPosture: posture,
          providerReadiness: dependencies.providerReadiness,
          uuid: dependencies.uuid,
          ...(poolRoutingContext === undefined ? {} : { poolRouting: poolRoutingContext }),
          ...(worktreeReceipts === undefined ? {} : { worktreeReceipts }),
          ...(admittedWorkspace === undefined ? {} : { admittedWorkspace }),
          ...(dependencies.parentContext === undefined
            ? {}
            : { parentContext: dependencies.parentContext }),
        });
      } catch (error) {
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
          // approval Ask requires (see the PR description's residual notes
          // on the deferred autonomous propose/confirm two-phase flow).
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

    return failure("AgentRun route not found.", 404, origin);
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

function matchesIdempotentCreationRequest(
  existing: AgentRun,
  request: ReturnType<typeof decodeAgentRunCreationRequest>,
  authority: {
    readonly parentAuthority: AgentRunAuthority;
    readonly liveAuthority: AgentRunAuthority;
  },
): boolean {
  return (
    existing.parentThreadId === request.parentThreadId &&
    existing.parentRunId === request.parentRunId &&
    existing.role === request.role &&
    existing.task === request.task &&
    existing.workspaceReceipt.kind === request.workspace.kind &&
    existing.workspaceReceipt.mode === request.workspace.mode &&
    existing.routingReceipt.mode === request.mode &&
    existing.routingReceipt.selectedProviderInstanceId === request.providerInstanceId &&
    existing.routingReceipt.selectedModelId === request.modelId &&
    existing.routingReceipt.rawReasoning === request.reasoning &&
    existing.routingReceipt.effectiveAuthorityDigest ===
      agentRunRequestAuthorityDigest(request.requestedAuthority) &&
    matchesIdempotentPool(existing.routingReceipt.poolRoute?.decision.request.pool, request.pool) &&
    // A retried request ID must carry the same parent-context ask the stored
    // child was admitted under; otherwise the receipt would answer for a child
    // scoped to different context than the caller now asks for.
    (existing.routingReceipt.admittedContextBlocks !== undefined) ===
      (request.includeParentContext === true) &&
    authorityIsWithin(existing.authority, authority.parentAuthority) &&
    authorityIsWithin(existing.authority, authority.liveAuthority)
  );
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
