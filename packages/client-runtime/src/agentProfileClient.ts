import {
  decodeAgentProfile,
  decodeAgentProfileCommandResult,
  decodeExecutionResolutionReceipt,
  type AgentProfile,
  type AgentProfileCommandResult,
  type AgentProfileId,
  type ExecutionResolutionReceipt,
} from "@octant/contracts";

export interface AgentProfileClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface AgentProfileClient {
  list(): Promise<ReadonlyArray<AgentProfile>>;
  read(profileId: AgentProfileId): Promise<AgentProfile | undefined>;
  execute(command: unknown): Promise<AgentProfileCommandResult>;
  resolveEffectiveProfile(request: unknown): Promise<ExecutionResolutionReceipt>;
}

export class AgentProfileClientFailure extends Error {
  readonly category: AgentProfileFailureCategory;
  constructor(
    failure:
      | { category: AgentProfileFailureCategory; message: string }
      | { reason: string; message: string },
  ) {
    super("message" in failure ? failure.message : "Agent profile request failed.");
    this.name = "AgentProfileClientFailure";
    this.category = "category" in failure ? failure.category : mapReason(failure.reason);
  }
}

type AgentProfileFailureCategory =
  | "invalid"
  | "unauthorized"
  | "unsupported"
  | "unavailable"
  | "not-found"
  | "conflict"
  | "protocol";

function mapReason(reason: string): AgentProfileFailureCategory {
  if (reason === "stale-version" || reason === "in-use") return "conflict";
  if (reason === "unauthorized") return "unauthorized";
  return "invalid";
}

export function createAgentProfileClient(options: AgentProfileClientOptions): AgentProfileClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    list() {
      return request(
        options.fetch,
        new URL("/api/agent-profiles", options.baseUrl).toString(),
        { method: "GET", headers },
        (body) => {
          if (!Array.isArray(body)) throw new Error("Expected array");
          return body.map((item) => decodeAgentProfile(item));
        },
        [],
      );
    },
    read(profileId) {
      return request(
        options.fetch,
        new URL(`/api/agent-profiles/${encodeURIComponent(profileId)}`, options.baseUrl).toString(),
        { method: "GET", headers },
        (body) => (body === null ? undefined : decodeAgentProfile(body)),
      );
    },
    execute(command) {
      return request(
        options.fetch,
        new URL("/api/agent-profiles/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeAgentProfileCommandResult,
      );
    },
    resolveEffectiveProfile(input) {
      return request(
        options.fetch,
        new URL("/api/agent-profiles/resolve-effective-profile", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        decodeExecutionResolutionReceipt,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  notFoundValue?: T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable();
  }
  if (response.status === 404) {
    return notFoundValue as T;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw protocol();
  }
  if (!response.ok) {
    if (isRecord(body) && typeof body.message === "string") {
      throw new AgentProfileClientFailure({
        category: mapStatus(response.status),
        message: body.message,
      });
    }
    throw protocol();
  }
  try {
    return decode(body);
  } catch {
    throw protocol();
  }
}

function mapStatus(status: number): AgentProfileFailureCategory {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 503) return "unavailable";
  if (status === 400) return "invalid";
  return "protocol";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): AgentProfileClientFailure {
  return new AgentProfileClientFailure({
    category: "unavailable",
    message: "Octant Agent Profile service is unavailable.",
  });
}

function protocol(): AgentProfileClientFailure {
  return new AgentProfileClientFailure({
    category: "protocol",
    message: "Agent Profile service returned an invalid response.",
  });
}
