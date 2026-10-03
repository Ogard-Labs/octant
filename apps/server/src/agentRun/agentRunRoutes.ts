import { observedChildren } from "./agentObservedChildren";
import { decodeAgentRunResultsResponse, type AgentObservedChild } from "@octant/contracts";
import {
  decodeAgentRunCenterQuery,
  decodeAgentRunId,
  decodeAgentRunCanvasSnapshotRequest,
  decodeAgentRunCanvasSnapshotResult,
  decodeAgentRunParentThreadId,
  decodeAgentRunResumeRequest,
  decodeAgentRunRetryRequest,
  decodeAgentRunSteerRequest,
  decodeAgentRunConversationStreamFrame,
  MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES,
  MAX_AGENT_RUN_CENTER_QUERY_LIMIT,
  type AgentRunConversationResponse,
  type AgentRunConversationStreamFrame,
  type AgentRun,
  type AgentRunCanvasSnapshotResult,
  type CanvasBlock,
  type AgentRunCenterSummary,
  type AgentRunId,
  type AgentRunParentThreadId,
  type AggregateVersion,
  type CodeThreadId,
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
} from "@octant/domain/agent-run-control-policy";
import { resolveAgentRunConversationDisclosure } from "@octant/domain/agent-run-conversation-policy";
import {
  agentRunForestCanvasTitle,
  buildAgentRunForest,
  buildAgentRunForestCanvasBlocks,
  effectiveAgentRunExecutionTarget,
} from "@octant/domain";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { isAgentRunTargetEligible, type AgentsToolTarget } from "./agentRunDelegation";
import type { AgentRunControlParentFacts } from "./agentRunControlService";
import type { AgentRunControlAdmissionDependencies } from "./agentRunControlAdmission";
import type { AgentRunOrchestrationService } from "./agentRunOrchestrationService";
import type { AgentRunPersistenceService } from "./agentRunPersistenceService";
import type { AgentRunLiveConversationStore } from "./agentRunLiveConversationStore";
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
  readonly readObservations?: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly windowId: string;
  }) => {
    readonly observations: ReadonlyArray<AgentObservedChild>;
    readonly observationsTruncated: boolean;
  };

  readonly listTargets: (parent: AgentRunControlParentFacts) => ReadonlyArray<AgentsToolTarget>;
  readonly onExecutionAccepted?: AgentRunControlAdmissionDependencies["onExecutionAccepted"];
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly persistence: AgentRunPersistenceService;
  readonly liveConversations: AgentRunLiveConversationStore;
  readonly orchestration: AgentRunOrchestrationService;
  /**
   * Resolves the actual parent thread/window authority a retried or resumed
   * child runs under; client body fields are never authority.
   */
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
   * Resolves display facts for one center row after authorization. Parent
   * titles come from this host's thread stores; child thread ids are derived
   * for Code children without inventing filesystem paths.
   */
  readonly resolveCenterContext: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly mode: OctantMode;
    readonly requestId: AgentRun["requestId"];
    readonly workspaceReceipt: AgentRun["workspaceReceipt"];
  }) => {
    readonly parentThreadTitle: string;
    readonly childThreadId?: CodeThreadId;
  };
  /**
   * Persist the parent thread's AgentRun forest as a Canvas document. Absent
   * means this host cannot snapshot graphs, so the route fails closed.
   */
  readonly snapshotCanvas?: (input: {
    readonly parentThreadId: AgentRunParentThreadId;
    readonly mode: OctantMode;
    readonly title: string;
    readonly blocks: ReadonlyArray<CanvasBlock>;
  }) => AgentRunCanvasSnapshotResult | Promise<AgentRunCanvasSnapshotResult>;
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

/**
 * Authenticated AgentRun query/command routes for the shared renderer.
 * Authority and lifecycle remain server-owned; the client reads summaries and
 * controls runs that already exist (acknowledge, cancel, steer, retry, resume)
 * with expected versions. Nothing here starts a subagent: only the thread's
 * own agent does, through the Octant Harness delegate tool, so the child's
 * result returns to the agent that asked for it.
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

    if (request.method === "POST" && url.pathname === "/api/agent-runs/canvas-snapshot") {
      return handleCanvasSnapshot(dependencies, authenticatedWindowId, request, origin);
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
      const entries = dependencies.persistence.parentSummary(parentThreadId, (run) =>
        dependencies.authorizeCancellation({ run, windowId: authenticatedWindowId }),
      );
      const root = dependencies.readObservations?.({
        parentThreadId,
        windowId: authenticatedWindowId,
      });
      const observations = [...(root?.observations ?? [])];
      let observationsTruncated = root?.observationsTruncated ?? false;
      for (const entry of entries) {
        const run = dependencies.persistence.getById(entry.runId);
        if (run === undefined) continue;
        const conversation = dependencies.liveConversations.read({ runId: run.id });
        const nested = observedChildren({
          parentThreadId,
          mode: run.routingReceipt.mode,
          parentRunId: run.id,
          events:
            conversation?.entries.flatMap((item) =>
              item.childActivity === undefined ? [] : [item.childActivity],
            ) ?? [],
          truncated: conversation?.truncated ?? false,
        });
        observations.push(...nested.observations);
        observationsTruncated ||= nested.observationsTruncated;
      }
      return json(
        {
          parentThreadId,
          entries: serializeEntries(entries).map((entry) => {
            const results = dependencies.persistence.resultPackets(entry.runId);
            return {
              ...entry,
              resultPackets: results.packets,
              resultsTruncated: results.truncated,
            };
          }),
          observations: observations.slice(0, 64),
          observationsTruncated: observationsTruncated || observations.length > 64,
        },
        200,
        origin,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs/results") {
      let runId: AgentRunId;
      try {
        runId = decodeAgentRunId(url.searchParams.get("runId") ?? "");
      } catch {
        return failure("AgentRun result runId is invalid.", 400, origin);
      }
      const run = dependencies.persistence.getById(runId);
      if (
        run === undefined ||
        !dependencies.authorizeCancellation({ run, windowId: authenticatedWindowId }) ||
        !(await dependencies.authorizeParentThread({
          parentThreadId: run.parentThreadId,
          windowId: authenticatedWindowId,
        }))
      ) {
        return failure("AgentRun results are not authorized for this run.", 403, origin);
      }
      return json(
        decodeAgentRunResultsResponse(dependencies.persistence.resultPackets(runId)),
        200,
        origin,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs/conversation") {
      return handleConversation(dependencies, authenticatedWindowId, url, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/agent-runs/conversation/stream") {
      return handleConversationStream(
        dependencies,
        authenticatedWindowId,
        url,
        origin,
        request.signal,
      );
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

    if (request.method === "POST" && url.pathname === "/api/agent-runs/usage-resume") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun usage-resume body is invalid.", 400, origin);
      }
      if (!isRecord(body)) return failure("AgentRun usage-resume body is invalid.", 400, origin);
      const action = body.action;
      if (action !== "schedule" && action !== "cancel") {
        return failure("AgentRun usage-resume action is invalid.", 400, origin);
      }
      let runId: AgentRunId;
      let expectedVersion: number;
      try {
        runId = decodeAgentRunId(body.runId);
        expectedVersion = Number(body.expectedVersion);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
          throw new Error("bad version");
        }
      } catch {
        return failure("AgentRun usage-resume fields are invalid.", 400, origin);
      }
      // The opt-in derives only from facts the run journaled; the body names
      // the run and the intended action, never the reset or provider claims.
      const run = dependencies.persistence.getById(runId);
      if (
        run === undefined ||
        !(await dependencies.authorizeParentThread({
          parentThreadId: run.parentThreadId,
          windowId: authenticatedWindowId,
        }))
      ) {
        return failure("AgentRun usage-resume is not authorized for this run.", 403, origin);
      }
      const result = dependencies.persistence.applyCommand({
        kind:
          action === "schedule"
            ? "schedule-agent-run-usage-resume"
            : "cancel-agent-run-usage-resume",
        runId,
        expectedVersion: expectedVersion as never,
      });
      return json(result, result.kind === "run-updated" ? 200 : 409, origin);
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

async function handleConversation(
  dependencies: AgentRunRouteDependencies,
  windowId: string,
  url: URL,
  origin: string | null,
): Promise<Response> {
  if (
    ![...url.searchParams.keys()].every((key) => key === "runId" || key === "afterSequence") ||
    !url.searchParams.has("runId")
  ) {
    return failure("AgentRun conversation query is invalid.", 400, origin);
  }
  let runId: AgentRunId;
  try {
    runId = decodeAgentRunId(url.searchParams.get("runId") ?? "");
  } catch {
    return failure("AgentRun conversation runId is invalid.", 400, origin);
  }
  const afterRaw = url.searchParams.get("afterSequence");
  let afterSequence: number | undefined;
  if (afterRaw !== null) {
    const parsed = Number(afterRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return failure("AgentRun conversation cursor is invalid.", 400, origin);
    }
    afterSequence = parsed;
  }
  const run = dependencies.persistence.getById(runId);
  if (
    run === undefined ||
    !dependencies.authorizeCancellation({ run, windowId }) ||
    !(await dependencies.authorizeParentThread({
      parentThreadId: run.parentThreadId,
      windowId,
    }))
  ) {
    return failure("AgentRun conversation is not authorized for this run.", 403, origin);
  }

  const live = dependencies.liveConversations.read({
    runId,
    ...(afterSequence === undefined ? {} : { afterSequence }),
  });
  return json(
    {
      ...conversationIdentity(run),
      ...agentRunConversationDisclosure(dependencies, run, {
        surface: "snapshot",
        ...(afterSequence === undefined ? {} : { afterSequence }),
        ...(live === undefined ? {} : { live }),
      }),
    } satisfies AgentRunConversationResponse,
    200,
    origin,
  );
}

async function handleConversationStream(
  dependencies: AgentRunRouteDependencies,
  windowId: string,
  url: URL,
  origin: string | null,
  signal: AbortSignal,
): Promise<Response> {
  if (
    ![...url.searchParams.keys()].every((key) => key === "runId" || key === "afterSequence") ||
    !url.searchParams.has("runId")
  ) {
    return failure("AgentRun conversation stream query is invalid.", 400, origin);
  }
  let runId: AgentRunId;
  try {
    runId = decodeAgentRunId(url.searchParams.get("runId") ?? "");
  } catch {
    return failure("AgentRun conversation stream runId is invalid.", 400, origin);
  }
  const afterRaw = url.searchParams.get("afterSequence");
  let afterSequence = 0;
  if (afterRaw !== null) {
    const parsed = Number(afterRaw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return failure("AgentRun conversation stream cursor is invalid.", 400, origin);
    }
    afterSequence = parsed;
  }
  const run = dependencies.persistence.getById(runId);
  if (
    run === undefined ||
    !dependencies.authorizeCancellation({ run, windowId }) ||
    !(await dependencies.authorizeParentThread({
      parentThreadId: run.parentThreadId,
      windowId,
    }))
  ) {
    return failure("AgentRun conversation stream is not authorized for this run.", 403, origin);
  }

  const frames = conversationStreamFrames(dependencies, run, afterSequence, signal, windowId);
  return conversationStreamResponse(frames, signal, origin);
}

async function* conversationStreamFrames(
  dependencies: AgentRunRouteDependencies,
  run: AgentRun,
  afterSequence: number,
  signal: AbortSignal,
  windowId: string,
): AsyncGenerator<AgentRunConversationStreamFrame> {
  const nativeLivePermitted = run.executionKind !== "provider-native";
  if (nativeLivePermitted) {
    const liveSnapshot = dependencies.liveConversations.read({
      runId: run.id,
      afterSequence,
    });
    if (liveSnapshot !== undefined) {
      let first = true;
      for await (const snapshot of dependencies.liveConversations.subscribe({
        runId: run.id,
        afterSequence,
        signal,
      })) {
        const latestRun = dependencies.persistence.getById(run.id);
        if (
          latestRun === undefined ||
          !dependencies.authorizeCancellation({ run: latestRun, windowId }) ||
          !(await dependencies.authorizeParentThread({
            parentThreadId: latestRun.parentThreadId,
            windowId,
          }))
        )
          return;
        const lastSequence = snapshot.entries.at(-1)?.sequence;
        yield {
          kind: first ? "snapshot" : "delta",
          ...conversationIdentity(latestRun),
          ...snapshot,
          ...(lastSequence === undefined ? {} : { nextCursor: String(lastSequence) }),
        };
        first = false;
      }
      return;
    }
  }

  const latestRun = dependencies.persistence.getById(run.id) ?? run;
  const disclosure = agentRunConversationDisclosure(dependencies, latestRun, {
    surface: "stream",
    afterSequence,
    live: dependencies.liveConversations.read({ runId: latestRun.id, afterSequence }),
  });
  const lastSequence = disclosure.entries.at(-1)?.sequence;
  yield {
    kind: "snapshot",
    ...conversationIdentity(latestRun),
    ...disclosure,
    ...(lastSequence === undefined ? {} : { nextCursor: String(lastSequence) }),
  };
}

function conversationIdentity(
  run: AgentRun,
): Omit<
  AgentRunConversationResponse,
  "status" | "entries" | "truncated" | "nextCursor" | "staleReason"
> {
  return {
    runId: run.id,
    parentThreadId: run.parentThreadId,
    executionKind: run.executionKind,
    modelId: effectiveAgentRunExecutionTarget(run.routingReceipt).modelId,
    lifecycleStatus: run.lifecycleStatus,
  };
}

function agentRunConversationDisclosure(
  dependencies: AgentRunRouteDependencies,
  run: AgentRun,
  options: {
    readonly surface: "snapshot" | "stream";
    readonly afterSequence?: number;
    readonly live?: ReturnType<AgentRunLiveConversationStore["read"]>;
  },
) {
  const result = run.result;
  const resultText = result === undefined ? undefined : dependencies.persistence.resultText(run.id);
  return resolveAgentRunConversationDisclosure({
    executionKind: run.executionKind,
    lifecycleStatus: run.lifecycleStatus,
    surface: options.surface,
    ...(run.recoveryReason === undefined ? {} : { recoveryReason: run.recoveryReason }),
    ...(run.executionKind === "provider-native"
      ? { nativeLiveTranscriptSupport: "unavailable" as const }
      : {}),
    ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
    ...(options.live === undefined ? {} : { live: options.live }),
    ...(result === undefined || resultText === undefined
      ? {}
      : {
          retained: {
            text: resultText,
            truncated: result.truncated,
            occurredAt: run.updatedAt,
          },
        }),
  });
}

function conversationStreamResponse(
  frames: AsyncIterable<AgentRunConversationStreamFrame>,
  signal: AbortSignal,
  origin: string | null,
): Response {
  const encoder = new TextEncoder();
  const iterator = frames[Symbol.asyncIterator]();
  const abort = (): void => {
    void iterator.return?.(undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) {
          controller.close();
          return;
        }
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        const decoded = decodeAgentRunConversationStreamFrame(next.value);
        const line = `${JSON.stringify(decoded)}\n`;
        if (encoder.encode(line).byteLength > MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES) {
          controller.error(new Error("AgentRun conversation stream frame is too large."));
          return;
        }
        controller.enqueue(encoder.encode(line));
      } catch {
        controller.close();
      }
    },
    async cancel() {
      signal.removeEventListener("abort", abort);
      await iterator.return?.(undefined);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

async function handleCanvasSnapshot(
  dependencies: AgentRunRouteDependencies,
  windowId: string,
  request: Request,
  origin: string | null,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("AgentRun canvas snapshot body is invalid.", 400, origin);
  }
  let parentThreadId: AgentRunParentThreadId;
  try {
    parentThreadId = decodeAgentRunCanvasSnapshotRequest(body).parentThreadId;
  } catch {
    return failure("parentThreadId is invalid.", 400, origin);
  }
  if (
    !(await dependencies.authorizeParentThread({
      parentThreadId,
      windowId,
    }))
  ) {
    return failure("AgentRun canvas snapshot is not authorized for this thread.", 403, origin);
  }

  const candidates = dependencies.persistence.listCenterCandidates({
    status: "all",
    mode: "all",
    parentThreadId,
  });
  const items = candidates
    .filter((candidate) => dependencies.authorizeCancellation({ run: candidate.run, windowId }))
    .map((candidate) => serializeCenterSummary(candidate, dependencies.resolveCenterContext));
  const forest = buildAgentRunForest(items);
  const thread = forest.threads[0];
  if (thread === undefined || items.length === 0) {
    return json(
      decodeAgentRunCanvasSnapshotResult({
        kind: "denied",
        message: "This thread has no agent runs to save.",
      }),
      200,
      origin,
    );
  }
  const blocks = buildAgentRunForestCanvasBlocks({ threads: [thread] });
  if (blocks.length === 0) {
    return json(
      decodeAgentRunCanvasSnapshotResult({
        kind: "denied",
        message: "This thread has no agent runs to save.",
      }),
      200,
      origin,
    );
  }
  const snapshotCanvas = dependencies.snapshotCanvas;
  if (snapshotCanvas === undefined) {
    return json(
      decodeAgentRunCanvasSnapshotResult({
        kind: "denied",
        message: "Canvas is unavailable on this host.",
      }),
      200,
      origin,
    );
  }
  const result = await snapshotCanvas({
    parentThreadId,
    mode: thread.mode,
    title: agentRunForestCanvasTitle(thread.title),
    blocks,
  });
  return json(decodeAgentRunCanvasSnapshotResult(result), 200, origin);
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
      dependencies.authorizeCancellation({ run: candidate.run, windowId }) &&
      (await dependencies.authorizeParentThread({
        parentThreadId: candidate.run.parentThreadId,
        windowId,
      }))
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
    requestId: run.requestId,
    workspaceReceipt: run.workspaceReceipt,
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
    ...(run.routingReceipt.normalizedReasoning === undefined
      ? {}
      : { normalizedReasoning: run.routingReceipt.normalizedReasoning }),
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    ...(run.usageLimit === undefined ? {} : { usageLimit: run.usageLimit }),
    ...(run.usageResume === undefined ? {} : { usageResume: run.usageResume }),
    version: run.version,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
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
      message = decoded.message;
    }
  } catch {
    return failure(`AgentRun ${action} fields are invalid.`, 400, origin);
  }
  const run = dependencies.persistence.getById(runId);
  if (
    run === undefined ||
    !dependencies.authorizeCancellation({ run, windowId }) ||
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
      assertAgentRunResumeAllowed(run, expectedVersion as AggregateVersion, message);
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
  if (action === "resume" && !isAgentRunTargetEligible(run, dependencies.listTargets(parent))) {
    return json(
      {
        kind: "run-command-failed",
        reason: "unsupported-transition",
        message:
          "The child's provider, model or reasoning choice is no longer available for this parent.",
      },
      409,
      origin,
    );
  }
  const result =
    action === "retry"
      ? dependencies.orchestration.retry(runId, expectedVersion, parent.liveAuthority)
      : await dependencies.orchestration.resume(runId, expectedVersion, parent.liveAuthority, {
          ...(message === undefined ? {} : { message }),
          resolveLiveAuthority: () => {
            const currentParent = dependencies.authorizeCreation({
              parentThreadId: run.parentThreadId,
              windowId,
            });
            if (
              currentParent === undefined ||
              currentParent.parentMode !== run.routingReceipt.mode ||
              currentParent.parentRoute.projectId !== run.routingReceipt.projectId ||
              !isAgentRunTargetEligible(run, dependencies.listTargets(currentParent))
            )
              return undefined;
            return currentParent.liveAuthority;
          },
          onExecutionAccepted: (accepted) =>
            dependencies.onExecutionAccepted?.({ run: accepted, windowId, operation: "resume" }),
        });
  if (
    action === "retry" &&
    result.kind === "run-updated" &&
    result.run.lifecycleStatus === "starting"
  ) {
    // The runtime awaits workspace verification before acquiring a provider.
    // Bind synchronously after acceptance, before that asynchronous boundary resumes.
    dependencies.onExecutionAccepted?.({ run: result.run, windowId, operation: action });
  }
  return json(result, result.kind === "run-command-failed" ? 409 : 200, origin);
}

/**
 * A retried request ID must carry the exact pool (or absence of one) that the
 * stored immutable route was decided from; otherwise the receipt would claim
 * a decision the caller never requested.
 */
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
    ...(entry.usageLimit === undefined ? {} : { usageLimit: entry.usageLimit }),
    ...(entry.usageResume === undefined ? {} : { usageResume: entry.usageResume }),
    version: entry.version,
    updatedAt: entry.updatedAt,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
