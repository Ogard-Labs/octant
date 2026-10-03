import {
  decodeAgentRunCommandResult,
  decodeAgentObservedChild,
  decodeAgentRunResultsResponse,
  type AgentObservedChild,
  type AgentRunResultPacket,
  type AgentRunResultsResponse,
  decodeAgentRunCanvasSnapshotRequest,
  decodeAgentRunCanvasSnapshotResult,
  decodeAgentRunCenterResponse,
  decodeAgentRunConversationResponse,
  decodeAgentRunConversationStreamFrame,
  MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES,
  decodeAgentRunParentThreadId,
  decodeAgentRunResumeRequest,
  decodeAgentRunRetryRequest,
  decodeAgentRunSteerRequest,
  type AgentRunCanvasSnapshotResult,
  type AgentRunCenterQuery,
  type AgentRunCenterResponse,
  type AgentRunConversationResponse,
  type AgentRunConversationStreamFrame,
  type AgentRunCommandResult,
  type AgentRunId,
  type AgentRunParentThreadId,
  type AgentRunResumeRequest,
  type AgentRunRetryRequest,
  type AgentRunSteerRequest,
  type ProviderUsageLimit,
  type UsageResumeThreadState,
} from "@octant/contracts";

/**
 * Loosely-typed client-side view of `AgentRunCommandResult`. Mirrors
 * `AgentRunParentSummaryClientEntry` below in trusting the server's response
 * shape rather than round-tripping through the full strict `AgentRun`
 * schema decode on every read, which would otherwise force every caller to
 * supply the entire (large) AgentRun shape just to read a status.
 */
export interface AgentRunClientCommandResult {
  readonly kind: "run-accepted" | "run-updated" | "run-command-failed";
  readonly run?: {
    readonly id: AgentRunId;
    readonly lifecycleStatus: string;
    readonly task?: string;
    readonly recoveryReason?: string;
    readonly [key: string]: unknown;
  };
  readonly reason?: string;
  readonly message?: string;
}

export interface AgentRunClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface AgentRunParentSummaryResponse {
  readonly observations?: ReadonlyArray<AgentObservedChild>;
  readonly observationsTruncated?: boolean;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly entries: ReadonlyArray<AgentRunParentSummaryClientEntry>;
}

/**
 * Honest server-authored route receipt data for one child run: the
 * originally requested target, the effective execution target (explicit
 * fallback aware), and whether the route was derived from a multi-model pool.
 */
export interface AgentRunClientRoute {
  readonly requestedProviderInstanceId: string;
  readonly requestedModelId: string;
  readonly executionProviderInstanceId: string;
  readonly executionModelId: string;
  readonly poolDerived: boolean;
  readonly selectionKind?: "requested" | "fallback";
  readonly routingReason?: string;
}

export interface AgentRunParentSummaryClientEntry {
  readonly resultPackets?: ReadonlyArray<AgentRunResultPacket>;
  readonly resultsTruncated?: boolean;
  readonly runId: AgentRunId;
  readonly requestId: string;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly parentRunId?: AgentRunId;
  readonly role: string;
  readonly task: string;
  readonly lifecycleStatus: string;
  readonly executionKind: string;
  readonly usageQuality: string;
  readonly route?: AgentRunClientRoute;
  readonly resultAcknowledgement: {
    readonly required: boolean;
    readonly acknowledged: boolean;
    readonly followUpReason?: string;
  };
  /**
   * The completed child's reply; absent until the run completes. `text` is
   * absent when the reply was purged with a permanently deleted parent thread,
   * so a reader can tell it is gone rather than read it as empty.
   */
  readonly result?: {
    readonly reference: string;
    readonly text?: string;
    readonly truncated: boolean;
  };
  readonly recoveryReason?: string;
  /** The normalized limit fact the host journaled when the run last waited. */
  readonly usageLimit?: ProviderUsageLimit;
  /** An armed or settled usage-resume opt-in, when one exists. */
  readonly usageResume?: UsageResumeThreadState;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentRunCenterQueryInput {
  readonly status?: AgentRunCenterQuery["status"];
  readonly mode?: AgentRunCenterQuery["mode"];
  readonly projectId?: string;
  readonly providerInstanceId?: string;
  readonly parentThreadId?: AgentRunParentThreadId;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AgentRunClient {
  results?(runId: AgentRunId): Promise<AgentRunResultsResponse>;
  center(input?: AgentRunCenterQueryInput): Promise<AgentRunCenterResponse>;
  conversation(runId: AgentRunId, afterSequence?: number): Promise<AgentRunConversationResponse>;
  /**
   * Opens one authenticated NDJSON subscription. The first frame is a bounded
   * snapshot and later frames are cursor-safe deltas until completion, stale,
   * abort, or disconnect. The caller owns the AbortSignal and must close it
   * when the selected pane unmounts or changes.
   */
  subscribeConversation?(
    runId: AgentRunId,
    afterSequence: number | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AgentRunConversationStreamFrame>;
  parentSummary(parentThreadId: AgentRunParentThreadId): Promise<AgentRunParentSummaryResponse>;
  /** Persist the parent thread's AgentRun forest as a Canvas document. */
  snapshotCanvas(parentThreadId: AgentRunParentThreadId): Promise<AgentRunCanvasSnapshotResult>;
  acknowledge(input: {
    readonly runId: AgentRunId;
    readonly expectedVersion: number;
  }): Promise<AgentRunCommandResult>;
  /** Cancels a run, its subtree, or its whole hierarchy leaf-first. */
  cancel(input: {
    readonly runId: AgentRunId;
    readonly scope: "self" | "subtree" | "hierarchy";
  }): Promise<{ readonly results: ReadonlyArray<AgentRunClientCommandResult> }>;
  steer(input: AgentRunSteerRequest): Promise<AgentRunClientCommandResult>;
  retry(input: AgentRunRetryRequest): Promise<AgentRunClientCommandResult>;
  resume(input: AgentRunResumeRequest): Promise<AgentRunClientCommandResult>;
  /** Arms or withdraws the opt-in to resume a usage-limited run at reset. */
  usageResume(input: {
    readonly runId: AgentRunId;
    readonly expectedVersion: number;
    readonly action: "schedule" | "cancel";
  }): Promise<AgentRunClientCommandResult>;
}

export class AgentRunClientFailure extends Error {
  constructor(
    readonly code: "unauthorized" | "invalid" | "unavailable" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunClientFailure";
  }
}

export function createAgentRunClient(options: AgentRunClientOptions): AgentRunClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    async center(input = {}) {
      const url = new URL("/api/agent-runs/center", options.baseUrl);
      url.searchParams.set("status", input.status ?? "all");
      url.searchParams.set("mode", input.mode ?? "all");
      if (input.projectId !== undefined) url.searchParams.set("projectId", input.projectId);
      if (input.providerInstanceId !== undefined) {
        url.searchParams.set("providerInstanceId", input.providerInstanceId);
      }
      if (input.parentThreadId !== undefined) {
        url.searchParams.set("parentThreadId", String(input.parentThreadId));
      }
      if (input.search !== undefined && input.search.trim().length > 0) {
        url.searchParams.set("search", input.search.trim());
      }
      if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
      if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
      const body = await requestJson(options.fetch, url.toString(), { method: "GET", headers });
      try {
        return decodeAgentRunCenterResponse(body);
      } catch {
        throw new AgentRunClientFailure("unavailable", "AgentRun center response is malformed.");
      }
    },
    async results(runId) {
      const url = new URL("/api/agent-runs/results", options.baseUrl);
      url.searchParams.set("runId", String(runId));
      const body = await requestJson(options.fetch, url.toString(), { method: "GET", headers });
      try {
        const result = decodeAgentRunResultsResponse(body);
        if (result.runId !== runId || result.packets.some((packet) => packet.runId !== runId))
          throw new Error("Result identity mismatch");
        return result;
      } catch {
        throw new AgentRunClientFailure("unavailable", "AgentRun results are malformed.");
      }
    },
    async conversation(runId, afterSequence) {
      const url = new URL("/api/agent-runs/conversation", options.baseUrl);
      url.searchParams.set("runId", String(runId));
      if (afterSequence !== undefined) url.searchParams.set("afterSequence", String(afterSequence));
      const body = await requestJson(options.fetch, url.toString(), { method: "GET", headers });
      try {
        return decodeAgentRunConversationResponse(body);
      } catch {
        throw new AgentRunClientFailure(
          "unavailable",
          "AgentRun conversation response is malformed.",
        );
      }
    },
    subscribeConversation(runId, afterSequence, signal) {
      const url = new URL("/api/agent-runs/conversation/stream", options.baseUrl);
      url.searchParams.set("runId", String(runId));
      if (afterSequence !== undefined) {
        url.searchParams.set("afterSequence", String(afterSequence));
      }
      return parseConversationStream(
        requestRaw(options.fetch, url.toString(), {
          method: "GET",
          headers,
          signal,
        }),
        runId,
        afterSequence ?? 0,
        signal,
      );
    },
    async snapshotCanvas(parentThreadId) {
      let validated;
      try {
        validated = decodeAgentRunCanvasSnapshotRequest({ parentThreadId });
      } catch {
        throw new AgentRunClientFailure("invalid", "AgentRun canvas snapshot request is invalid.");
      }
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-runs/canvas-snapshot", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
      );
      try {
        return decodeAgentRunCanvasSnapshotResult(body);
      } catch {
        throw new AgentRunClientFailure(
          "unavailable",
          "AgentRun canvas snapshot response is malformed.",
        );
      }
    },
    async parentSummary(parentThreadId) {
      const validated = decodeAgentRunParentThreadId(parentThreadId);
      const url = new URL("/api/agent-runs/parent-summary", options.baseUrl);
      url.searchParams.set("parentThreadId", String(validated));
      const body = await requestJson(options.fetch, url.toString(), { method: "GET", headers });
      if (!isRecord(body) || !Array.isArray(body.entries)) {
        throw new AgentRunClientFailure("unavailable", "AgentRun parent summary is malformed.");
      }
      try {
        const observations =
          body.observations === undefined
            ? undefined
            : Array.isArray(body.observations) && body.observations.length <= 64
              ? body.observations.map((child) => decodeAgentObservedChild(child))
              : (() => {
                  throw new Error("Invalid observations");
                })();
        if (
          observations?.some((child) => child.parentThreadId !== validated) ||
          (body.observationsTruncated !== undefined &&
            typeof body.observationsTruncated !== "boolean")
        )
          throw new Error("Observation identity mismatch");
        const entries = (body.entries as AgentRunParentSummaryClientEntry[]).map((entry) => {
          if (entry.resultPackets === undefined) return entry;
          const result = decodeAgentRunResultsResponse({
            runId: entry.runId,
            packets: entry.resultPackets,
            truncated: entry.resultsTruncated,
          });
          if (
            result.packets.some(
              (packet) => packet.runId !== entry.runId || packet.parentThreadId !== validated,
            )
          )
            throw new Error("Result identity mismatch");
          return { ...entry, resultPackets: result.packets, resultsTruncated: result.truncated };
        });
        return {
          parentThreadId: validated,
          entries,
          ...(observations === undefined ? {} : { observations }),
          ...(typeof body.observationsTruncated !== "boolean"
            ? {}
            : { observationsTruncated: body.observationsTruncated }),
        };
      } catch {
        throw new AgentRunClientFailure("unavailable", "AgentRun parent summary is malformed.");
      }
    },
    async acknowledge(input) {
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-runs/acknowledge", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            runId: input.runId,
            expectedVersion: input.expectedVersion,
          }),
        },
      );
      try {
        return decodeAgentRunCommandResult(body);
      } catch {
        throw new AgentRunClientFailure(
          "unavailable",
          "AgentRun acknowledge response is malformed.",
        );
      }
    },
    async cancel(input) {
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-runs/cancel", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ runId: input.runId, scope: input.scope }),
        },
        { structuredCommandResult: true },
      );
      if (!isRecord(body) || !Array.isArray(body.results)) {
        throw new AgentRunClientFailure("unavailable", "AgentRun cancel response is malformed.");
      }
      return { results: body.results as ReadonlyArray<AgentRunClientCommandResult> };
    },
    async steer(input) {
      return postRunCommand(options, headers, "/api/agent-runs/steer", () =>
        decodeAgentRunSteerRequest(input),
      );
    },
    async retry(input) {
      return postRunCommand(options, headers, "/api/agent-runs/retry", () =>
        decodeAgentRunRetryRequest(input),
      );
    },
    async resume(input) {
      return postRunCommand(options, headers, "/api/agent-runs/resume", () =>
        decodeAgentRunResumeRequest(input),
      );
    },
    async usageResume(input) {
      return postRunCommand(options, headers, "/api/agent-runs/usage-resume", () => ({
        runId: input.runId,
        expectedVersion: input.expectedVersion,
        action: input.action,
      }));
    },
  };
}

async function postRunCommand(
  options: AgentRunClientOptions,
  headers: { readonly "x-octant-window-capability": string },
  path: string,
  decode: () => unknown,
): Promise<AgentRunClientCommandResult> {
  let validated: unknown;
  try {
    validated = decode();
  } catch {
    throw new AgentRunClientFailure("invalid", "AgentRun command request is invalid.");
  }
  const body = await requestJson(
    options.fetch,
    new URL(path, options.baseUrl).toString(),
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(validated),
    },
    { structuredCommandResult: true },
  );
  if (!isRecord(body) || typeof body.kind !== "string") {
    throw new AgentRunClientFailure("unavailable", "AgentRun command response is malformed.");
  }
  return body as unknown as AgentRunClientCommandResult;
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  options: { readonly structuredCommandResult?: boolean } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new AgentRunClientFailure("unavailable", "Octant AgentRun service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentRunClientFailure("unavailable", "AgentRun response is malformed.");
  }
  if (response.status === 401) {
    throw new AgentRunClientFailure("unauthorized", "AgentRun request is unauthorized.");
  }
  // Command routes (cancel/steer/retry/resume) encode denial as a structured
  // `run-command-failed` result with an explicit `reason` rather than a bare
  // conflict; surface that to the caller instead of collapsing it into a
  // generic thrown failure that would lose the reason (e.g. "limit-reached"
  // vs. a stale-version race).
  if (options.structuredCommandResult && response.status === 409) {
    return body;
  }
  if (response.status === 409) {
    throw new AgentRunClientFailure("conflict", "AgentRun command conflict.");
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    throw new AgentRunClientFailure("invalid", message ?? "AgentRun request is invalid.");
  }
  return body;
}

async function requestRaw(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, init);
    if (response.status === 401) {
      throw new AgentRunClientFailure("unauthorized", "AgentRun request is unauthorized.");
    }
    if (!response.ok) {
      throw new AgentRunClientFailure(
        "unavailable",
        "AgentRun conversation stream is unavailable.",
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AgentRunClientFailure) throw error;
    throw new AgentRunClientFailure("unavailable", "AgentRun conversation stream is unavailable.");
  }
}

async function* parseConversationStream(
  responsePromise: Promise<Response>,
  runId: AgentRunId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<AgentRunConversationStreamFrame> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") {
    throw new AgentRunClientFailure(
      "unavailable",
      "AgentRun conversation stream content type is malformed.",
    );
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastSequence = afterSequence;
  let frameCount = 0;
  let first = true;
  const decodeLine = (line: string): AgentRunConversationStreamFrame => {
    if (new TextEncoder().encode(line).byteLength > MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES) {
      throw new AgentRunClientFailure(
        "unavailable",
        "AgentRun conversation stream frame is too large.",
      );
    }
    let frame: AgentRunConversationStreamFrame;
    try {
      frame = decodeAgentRunConversationStreamFrame(JSON.parse(line));
    } catch {
      throw new AgentRunClientFailure(
        "unavailable",
        "AgentRun conversation stream frame is malformed.",
      );
    }
    if (String(frame.runId) !== String(runId) || (first && frame.kind !== "snapshot")) {
      throw new AgentRunClientFailure(
        "unavailable",
        "AgentRun conversation stream frame is malformed.",
      );
    }
    for (const entry of frame.entries) {
      if (entry.sequence <= lastSequence) {
        throw new AgentRunClientFailure(
          "unavailable",
          "AgentRun conversation stream cursor regressed.",
        );
      }
      lastSequence = entry.sequence;
    }
    first = false;
    frameCount += 1;
    if (frameCount > 256) {
      throw new AgentRunClientFailure(
        "unavailable",
        "AgentRun conversation stream exceeded its frame budget.",
      );
    }
    return frame;
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readConversationStreamChunk(reader, signal);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) yield decodeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
      if (
        new TextEncoder().encode(buffer).byteLength > MAX_AGENT_RUN_CONVERSATION_NDJSON_LINE_BYTES
      ) {
        throw new AgentRunClientFailure(
          "unavailable",
          "AgentRun conversation stream frame is too large.",
        );
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) yield decodeLine(trailing);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation races while tearing down the stream.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore a reader already released by cancellation.
    }
  }
}

async function readConversationStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reader.cancel().then(
        () => resolve({ done: true, value: undefined as undefined }),
        (error) => reject(error),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new AgentRunClientFailure(
      "unavailable",
      "AgentRun client requires a loopback server URL.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
