import {
  decodeAgentRunCommandResult,
  decodeAgentRunCreationRequest,
  decodeAgentRunParentThreadId,
  type AgentRunCommandResult,
  type AgentRunCreationRequest,
  type AgentRunId,
  type AgentRunParentThreadId,
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
  readonly version: number;
  readonly updatedAt: string;
}

export interface AgentRunClient {
  parentSummary(parentThreadId: AgentRunParentThreadId): Promise<AgentRunParentSummaryResponse>;
  acknowledge(input: {
    readonly runId: AgentRunId;
    readonly expectedVersion: number;
  }): Promise<AgentRunCommandResult>;
  /** Proposes and creates a bounded child run. */
  requestRun(input: AgentRunCreationRequest): Promise<AgentRunClientCommandResult>;
  /** Cancels a run, its subtree, or its whole hierarchy leaf-first. */
  cancel(input: {
    readonly runId: AgentRunId;
    readonly scope: "self" | "subtree" | "hierarchy";
  }): Promise<{ readonly results: ReadonlyArray<AgentRunClientCommandResult> }>;
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
    async parentSummary(parentThreadId) {
      const validated = decodeAgentRunParentThreadId(parentThreadId);
      const url = new URL("/api/agent-runs/parent-summary", options.baseUrl);
      url.searchParams.set("parentThreadId", String(validated));
      const body = await requestJson(options.fetch, url.toString(), { method: "GET", headers });
      if (!isRecord(body) || !Array.isArray(body.entries)) {
        throw new AgentRunClientFailure("unavailable", "AgentRun parent summary is malformed.");
      }
      return {
        parentThreadId: validated,
        entries: body.entries as AgentRunParentSummaryClientEntry[],
      };
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
    async requestRun(input) {
      let validated: AgentRunCreationRequest;
      try {
        validated = decodeAgentRunCreationRequest(input);
      } catch {
        throw new AgentRunClientFailure("invalid", "AgentRun creation request is invalid.");
      }
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-runs/request", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        { structuredCommandResult: true },
      );
      if (!isRecord(body) || typeof body.kind !== "string") {
        throw new AgentRunClientFailure("unavailable", "AgentRun creation response is malformed.");
      }
      return body as unknown as AgentRunClientCommandResult;
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
  };
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
  // Command routes (request/cancel) encode denial as a structured
  // `run-command-failed` result with an explicit `reason` rather than a bare
  // conflict; surface that to the caller instead of collapsing it into a
  // generic thrown failure that would lose the reason (e.g. "posture-rejected"
  // vs. "limit-reached" vs. a stale-version race).
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
