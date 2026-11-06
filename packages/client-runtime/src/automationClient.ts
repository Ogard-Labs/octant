import {
  AutomationEventSourceChoices,
  type AutomationEventSourceChoice,
  type AutomationCommand,
  AutomationCommandResult,
  type AutomationDetailResponse,
  type AutomationHistoryResponse,
  type AutomationId,
  type AutomationListResponse,
  AutomationQueryResponse,
  decodeHostAnswer,
  type AutomationFollowUpRequest,
  type AutomationThreadRoutineRequest,
  type RoutineAgentRequest,
  type RoutineProposalDecision,
  RoutineProposalDecisionResult,
  RoutineProposalList,
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
  readonly mode?: "all" | "chat" | "work" | "code";
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
  readonly eventSources?: (
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<AutomationEventSourceChoice>>;
  list(input?: AutomationListInput, signal?: AbortSignal): Promise<AutomationListResponse>;
  get(
    automationId: AutomationId,
    signal?: AbortSignal,
    context?: { readonly fileSourceReview: true },
  ): Promise<AutomationDetailResponse>;
  history(input: AutomationHistoryInput, signal?: AbortSignal): Promise<AutomationHistoryResponse>;
  execute(command: AutomationClientCommand, signal?: AbortSignal): Promise<AutomationCommandResult>;
  /**
   * Set up or move a one-time follow-up in a thread. Setting one up creates
   * the routine as this window, from the thread's own facts.
   */
  followUp(
    request: AutomationFollowUpRequest,
    signal?: AbortSignal,
  ): Promise<AutomationCommandResult>;
  /**
   * Create a routine from a Work or Code thread, as this window. The host
   * takes the Project, mode, and authority from the thread itself.
   */
  createThreadRoutine(
    request: AutomationThreadRoutineRequest,
    signal?: AbortSignal,
  ): Promise<AutomationCommandResult>;
  /**
   * Routines this window's thread agents proposed, and pauses or archives
   * they asked for, waiting for the person.
   */
  listProposals(signal?: AbortSignal): Promise<ReadonlyArray<RoutineAgentRequest>>;
  /**
   * Confirm or decline one proposal or change request. A confirm creates the
   * routine, or pauses or archives it, as this window.
   */
  decideProposal(
    decision: RoutineProposalDecision,
    signal?: AbortSignal,
  ): Promise<RoutineProposalDecisionResult>;
}

export type AutomationClientFailureCategory =
  | "aborted"
  | "network"
  | "http"
  | "contract"
  | "timeout";

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
export const FILE_ROUTINE_REQUEST_TIMEOUT_MS = 30_000;

export function createAutomationClient(options: AutomationClientOptions): AutomationClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  return {
    eventSources(signal) {
      return request(
        options.fetch,
        new URL("/api/automations/event-sources", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(AutomationEventSourceChoices),
        maxAttempts,
        signal,
      );
    },
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
    get(automationId, signal, context) {
      const url = new URL("/api/automations/get", options.baseUrl);
      url.searchParams.set("automationId", String(automationId));
      if (context?.fileSourceReview)
        return fileRoutineRequest(
          (boundedSignal) =>
            request(
              options.fetch,
              url.toString(),
              { method: "GET", headers },
              (value) => {
                const detail = decodeQueryKind(value, "automation-detail");
                if (detail.automation.id !== automationId)
                  throw new AutomationClientFailure(
                    "contract",
                    "The file-routine review returned a different routine.",
                  );
                return detail;
              },
              1,
              boundedSignal,
            ),
          signal,
          "The file-routine details did not arrive in time. Refresh and try again.",
        );
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
      if (
        command.kind === "rearm-file-automation" ||
        ((command.kind === "create-automation" || command.kind === "update-automation") &&
          (command.definition.trigger.kind === "file-arrival" ||
            command.definition.trigger.kind === "integration-event"))
      ) {
        return fileRoutineRequest(
          (boundedSignal) =>
            request(
              options.fetch,
              new URL("/api/automations/commands", options.baseUrl).toString(),
              {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body: JSON.stringify(command),
              },
              (value) => decodeFileCommandResult(value, command),
              1,
              boundedSignal,
            ),
          signal,
          "The host has not confirmed this input-routine change. Refresh its details and history before trying again.",
        );
      }
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
    followUp(followUpRequest, signal) {
      // One attempt: a replayed set-up would create a second follow-up.
      return request(
        options.fetch,
        new URL("/api/automations/follow-ups", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(followUpRequest),
        },
        decodeCommandResult,
        1,
        signal,
      );
    },
    createThreadRoutine(routineRequest, signal) {
      // One attempt: a replayed create would make a second routine.
      return request(
        options.fetch,
        new URL("/api/automations/thread-routines", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(routineRequest),
        },
        decodeCommandResult,
        1,
        signal,
      );
    },
    listProposals(signal) {
      return request(
        options.fetch,
        new URL("/api/automations/proposals", options.baseUrl).toString(),
        { method: "GET", headers },
        (value) =>
          decodeProposalAnswer(() => decodeHostAnswer(RoutineProposalList)(value).proposals),
        maxAttempts,
        signal,
      );
    },
    decideProposal(decision, signal) {
      // One attempt: the host takes a proposal off the list on the first
      // answer it receives, so a replay could only report it gone.
      return request(
        options.fetch,
        new URL("/api/automations/proposals/decide", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(decision),
        },
        (value) =>
          decodeProposalAnswer(() => decodeHostAnswer(RoutineProposalDecisionResult)(value)),
        1,
        signal,
      );
    },
  };
}

/** A file setup/re-arm has one caller attempt and an unknown-outcome deadline, including body reads. */
async function fileRoutineRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const combined =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(new AutomationClientFailure("aborted", "Automation request was cancelled."));
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(combined),
      aborted,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AutomationClientFailure("timeout", timeoutMessage));
          controller.abort();
        }, FILE_ROUTINE_REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof AutomationClientFailure && error.category === "network")
      throw new AutomationClientFailure("network", timeoutMessage);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) combined.removeEventListener("abort", onAbort);
  }
}

function decodeProposalAnswer<T>(decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new AutomationClientFailure(
      "contract",
      "Routine proposal answer did not match the contract.",
    );
  }
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
    decoded = decodeHostAnswer(AutomationQueryResponse)(value);
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
    return decodeHostAnswer(AutomationCommandResult)(value);
  } catch {
    throw new AutomationClientFailure(
      "contract",
      "Automation command result did not match the contract.",
    );
  }
}

function decodeFileCommandResult(
  value: unknown,
  command: AutomationClientCommand,
): AutomationCommandResult {
  const result = decodeCommandResult(value);
  const owner =
    "automation" in result
      ? result.automation.id
      : "run" in result
        ? result.run.automationId
        : "automationId" in result
          ? result.automationId
          : undefined;
  if (owner !== undefined && owner !== command.automationId)
    throw new AutomationClientFailure("contract", "The host returned a different file routine.");
  if (command.kind === "rearm-file-automation" && result.kind === "automation-run-accepted") {
    const occurrence = result.run.occurrence;
    const review = occurrence.kind === "file-arrival" ? occurrence.source.rearm : undefined;
    if (
      command.disposition !== "run-once" ||
      review === undefined ||
      review.expectedDefinitionVersion !== command.expectedVersion ||
      review.previousSourceIdentity !== command.sourceIdentity ||
      review.previousObservationRevision !== command.observationRevision ||
      review.previousBatchDigest !== command.batchDigest
    )
      throw new AutomationClientFailure(
        "contract",
        "The host returned a different file-input decision.",
      );
  }
  return result;
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
