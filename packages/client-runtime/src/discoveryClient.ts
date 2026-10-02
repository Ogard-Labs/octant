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
        timeoutMs,
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

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await readResponse(fetch, url, { ...init, signal: controller.signal }, decode);
  } catch (error) {
    if (timedOut) {
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
    throw new DiscoveryClientFailure("unavailable", "Discovery service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
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
