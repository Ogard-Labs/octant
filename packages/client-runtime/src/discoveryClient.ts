import {
  decodeDiscoveryCommandResult,
  type DiscoveryCommand,
  type DiscoveryCommandResult,
  type DiscoverySnapshot,
} from "@octant/contracts";

export interface DiscoveryClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  /** How long a request may stay open before it fails as a timeout. */
  readonly timeoutMs?: number;
}

export interface DiscoveryClient {
  scan(): Promise<DiscoverySnapshot>;
  connect(command: Extract<DiscoveryCommand, { kind: "connect" }>): Promise<DiscoveryCommandResult>;
  /** Points a runtime at the executable behind a native file-picker receipt. */
  locateBinary(
    command: Extract<DiscoveryCommand, { kind: "locate-binary" }>,
  ): Promise<Extract<DiscoveryCommandResult, { kind: "binary-located" }>>;
}

export class DiscoveryClientFailure extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.name = "DiscoveryClientFailure";
    this.category = category;
  }
}

export function createDiscoveryClient(options: DiscoveryClientOptions): DiscoveryClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    scan() {
      return request(
        options.fetch,
        new URL("/api/providers/discovery/scan", options.baseUrl).toString(),
        { method: "POST", headers },
        (body) => {
          const result = decodeDiscoveryCommandResult(body);
          if (result.kind !== "scan-completed") {
            throw new DiscoveryClientFailure("protocol", "Expected scan-completed result.");
          }
          return result.snapshot;
        },
        timeoutMs,
      );
    },
    connect(command) {
      return request(
        options.fetch,
        new URL("/api/providers/discovery/connect", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        decodeDiscoveryCommandResult,
        // No client-side limit: the host does not cancel a connect when the
        // request is dropped, so timing out here would report a provider the
        // host goes on to create as failed and invite a duplicate.
        undefined,
      );
    },
    locateBinary(command) {
      return request(
        options.fetch,
        new URL("/api/providers/discovery/locate-binary", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        },
        (body) => {
          const result = decodeDiscoveryCommandResult(body);
          if (result.kind !== "binary-located") {
            throw new DiscoveryClientFailure("protocol", "Expected binary-located result.");
          }
          return result;
        },
        // Like connect: the host finishes a change it has started even when the
        // request is dropped, so a client timeout would misreport it.
        undefined,
      );
    },
  };
}

/**
 * The host's own scan budget is 10 s and each probe is cut off at 5 s, so a
 * request still open after this long means the host is wedged. Without a limit
 * the Settings page kept saying "Scanning…" for as long as the socket stayed open.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/** Thrown by a read the timeout aborted, so only that read becomes a timeout. */
const REQUEST_CUT_OFF: unique symbol = Symbol("discovery request cut off");

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return readResponse(fetch, url, init, decode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readResponse(fetch, url, { ...init, signal: controller.signal }, decode);
  } catch (error) {
    // Only a request the timer actually cut off is a timeout. A host error or
    // undecodable body that merely finished after the deadline keeps its own
    // category and message.
    if (error === REQUEST_CUT_OFF) {
      throw new DiscoveryClientFailure(
        "timeout",
        "The provider scan took too long to answer. Try again.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    if (init.signal?.aborted === true) throw REQUEST_CUT_OFF;
    throw new DiscoveryClientFailure("unavailable", "Discovery service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (init.signal?.aborted === true) throw REQUEST_CUT_OFF;
    throw new DiscoveryClientFailure("protocol", "Discovery service returned an invalid response.");
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : "Discovery service returned an error.";
    const category =
      typeof body === "object" &&
      body !== null &&
      "category" in body &&
      typeof body.category === "string"
        ? body.category
        : "unavailable";
    throw new DiscoveryClientFailure(category, message);
  }
  try {
    return decode(body);
  } catch {
    throw new DiscoveryClientFailure("protocol", "Discovery service returned an invalid response.");
  }
}
