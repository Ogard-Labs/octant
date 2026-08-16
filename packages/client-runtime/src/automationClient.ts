import {
  decodeAutomationCommandResult,
  decodeAutomationQueryResponse,
  type AutomationCommand,
  type AutomationCommandResult,
  type AutomationDetailResponse,
  type AutomationHistoryResponse,
  type AutomationId,
  type AutomationListResponse,
} from "@octant/contracts";

/**
 * Automation Center commands on the wire. The authenticated transport is the
 * only identity source: the server injects the verified principal and the
 * interactive origin, so the client type cannot carry either.
 */
export type AutomationClientCommand = AutomationCommand extends infer T
  ? T extends AutomationCommand
    ? Omit<T, "principal" | "origin">
    : never
  : never;

export interface AutomationListInput {
  readonly mode?: "all" | "work" | "code";
  readonly projectId?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AutomationHistoryInput {
  readonly automationId: AutomationId;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AutomationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  /**
   * Total attempts per request across reconnects. Queries are read-only and
   * every mutation carries an expected version or idempotent request ID, so a
   * replay after a dropped connection returns the original receipt (or a
   * typed stale-version failure) instead of a second side effect.
   */
  readonly maxAttempts?: number;
}

export interface AutomationClient {
  list(input?: AutomationListInput, signal?: AbortSignal): Promise<AutomationListResponse>;
  get(automationId: AutomationId, signal?: AbortSignal): Promise<AutomationDetailResponse>;
  history(input: AutomationHistoryInput, signal?: AbortSignal): Promise<AutomationHistoryResponse>;
  execute(command: AutomationClientCommand, signal?: AbortSignal): Promise<AutomationCommandResult>;
}

export type AutomationClientFailureCategory = "aborted" | "network" | "http" | "contract";

export class AutomationClientFailure extends Error {
  override readonly name = "AutomationClientFailure";
  readonly category: AutomationClientFailureCategory;
  readonly status: number;

  constructor(category: AutomationClientFailureCategory, message: string, status = 0) {
    super(message);
    this.category = category;
    this.status = status;
  }
}

const DEFAULT_MAX_ATTEMPTS = 2;

export function createAutomationClient(options: AutomationClientOptions): AutomationClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  return {
    list(input = {}, signal) {
      const url = new URL("/api/automations/list", options.baseUrl);
      url.searchParams.set("mode", input.mode ?? "all");
      if (input.projectId !== undefined) url.searchParams.set("projectId", input.projectId);
      if (input.search !== undefined && input.search.trim().length > 0) {
        url.searchParams.set("search", input.search);
      }
      if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
      if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        (value) => decodeQueryKind(value, "automation-list"),
        maxAttempts,
        signal,
      );
    },
    get(automationId, signal) {
      const url = new URL("/api/automations/get", options.baseUrl);
      url.searchParams.set("automationId", String(automationId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        (value) => decodeQueryKind(value, "automation-detail"),
        maxAttempts,
        signal,
      );
    },
    history(input, signal) {
      const url = new URL("/api/automations/history", options.baseUrl);
      url.searchParams.set("automationId", String(input.automationId));
      if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
      if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        (value) => decodeQueryKind(value, "automation-history"),
        maxAttempts,
        signal,
      );
    },
    execute(command, signal) {
      return request(
        options.fetch,
        new URL("/api/automations/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeCommandResult,
        maxAttempts,
        signal,
      );
    },
  };
}

function decodeQueryKind<K extends "automation-list" | "automation-detail" | "automation-history">(
  value: unknown,
  kind: K,
): Extract<
  AutomationListResponse | AutomationDetailResponse | AutomationHistoryResponse,
  { kind: K }
> {
  let decoded;
  try {
    decoded = decodeAutomationQueryResponse(value);
  } catch {
    throw new AutomationClientFailure(
      "contract",
      "Automation response did not match the contract.",
    );
  }
  if (decoded.kind !== kind) {
    throw new AutomationClientFailure(
      "contract",
      "Automation response was a different query kind than requested.",
    );
  }
  return decoded as never;
}

function decodeCommandResult(value: unknown): AutomationCommandResult {
  try {
    return decodeAutomationCommandResult(value);
  } catch {
    throw new AutomationClientFailure(
      "contract",
      "Automation command result did not match the contract.",
    );
  }
}

/**
 * One reconnect-safe request: transport drops are replayed with the identical
 * URL and body up to `maxAttempts` times, cancellation stops immediately, and
 * both success and failure bodies decode strictly before use.
 */
async function request<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  maxAttempts: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  let lastNetworkFailure: AutomationClientFailure | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isAborted(signal)) {
      throw new AutomationClientFailure("aborted", "Automation request was cancelled.");
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (isAborted(signal) || isAbortError(error)) {
        throw new AutomationClientFailure("aborted", "Automation request was cancelled.");
      }
      lastNetworkFailure = new AutomationClientFailure(
        "network",
        "Automation request failed to reach the host.",
      );
      continue;
    }
    return decodeResponse(response, decode);
  }
  throw (
    lastNetworkFailure ??
    new AutomationClientFailure("network", "Automation request failed to reach the host.")
  );
}

async function decodeResponse<T>(response: Response, decode: (value: unknown) => T): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new AutomationClientFailure(
      "contract",
      "Automation response was not valid JSON.",
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : "Automation request failed.";
    throw new AutomationClientFailure("http", message, response.status);
  }
  return decode(body);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// The abort flag can flip between attempts; keep the check opaque so type
// narrowing does not assume it is stable across the retry loop.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
