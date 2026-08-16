import {
  decodeBrowserActionCommand,
  decodeBrowserAutomationSnapshot,
  decodeBrowserContextCancelCommand,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadScope,
  decodeBrowserThreadContextCommand,
  decodeBrowserThreadScopeRequest,
  type BrowserActionCommand,
  type BrowserAutomationSnapshot,
  type BrowserContextCancelCommand,
  type BrowserContextCreateCommand,
  type BrowserContextInspectCommand,
  type BrowserContextStopCommand,
  type BrowserThreadScope,
  type BrowserThreadContextCommand,
  type BrowserThreadScopeRequest,
} from "@octant/contracts/browser-automation-rpc";
import {
  decodeBrowserAutomationFailure,
  type BrowserAutomationFailure,
} from "@octant/contracts/browser-automation";

export interface BrowserAutomationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface BrowserAutomationClient {
  resolve(input: BrowserThreadScopeRequest, signal?: AbortSignal): Promise<BrowserThreadScope>;
  create(
    input: BrowserContextCreateCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  inspect(
    input: BrowserContextInspectCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  inspectThread(
    input: BrowserThreadContextCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  releaseThread(
    input: BrowserThreadContextCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  act(input: BrowserActionCommand, signal?: AbortSignal): Promise<BrowserAutomationSnapshot>;
  cancel(
    input: BrowserContextCancelCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  stop(input: BrowserContextStopCommand, signal?: AbortSignal): Promise<BrowserAutomationSnapshot>;
}

export type BrowserAutomationClientFailureCategory =
  | BrowserAutomationFailure["category"]
  | "interrupted"
  | "protocol";

export class BrowserAutomationClientFailure extends Error {
  constructor(
    readonly category: BrowserAutomationClientFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "BrowserAutomationClientFailure";
  }
}

export function createBrowserAutomationClient(
  options: BrowserAutomationClientOptions,
): BrowserAutomationClient {
  return {
    resolve: (input, signal) =>
      post(
        options,
        "/api/browser/scope",
        decodeBrowserThreadScopeRequest(input),
        decodeBrowserThreadScope,
        signal,
      ),
    create: (input, signal) =>
      post(
        options,
        "/api/browser/contexts",
        decodeBrowserContextCreateCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    inspect: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/inspect",
        decodeBrowserContextInspectCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    inspectThread: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/current",
        decodeBrowserThreadContextCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    releaseThread: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/release",
        decodeBrowserThreadContextCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    act: (input, signal) =>
      post(
        options,
        "/api/browser/actions",
        decodeBrowserActionCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    cancel: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/cancel",
        decodeBrowserContextCancelCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
    stop: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/stop",
        decodeBrowserContextStopCommand(input),
        decodeBrowserAutomationSnapshot,
        signal,
      ),
  };
}

async function post<T>(
  options: BrowserAutomationClientOptions,
  path: string,
  body: unknown,
  decode: (input: unknown) => T,
  signal: AbortSignal | undefined,
): Promise<T> {
  let response: Response;
  try {
    const fetch = options.fetch;
    response = await fetch(new URL(path, options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      throw new BrowserAutomationClientFailure(
        "interrupted",
        "Browser automation request was interrupted.",
      );
    }
    throw new BrowserAutomationClientFailure(
      "unavailable",
      "Octant browser automation is unavailable.",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BrowserAutomationClientFailure(
      "protocol",
      "Browser automation returned an invalid response.",
    );
  }
  if (!response.ok) {
    try {
      const failure = decodeBrowserAutomationFailure(payload);
      throw new BrowserAutomationClientFailure(failure.category, failure.message);
    } catch (error) {
      if (error instanceof BrowserAutomationClientFailure) throw error;
      throw new BrowserAutomationClientFailure(
        "protocol",
        "Browser automation returned an invalid failure.",
      );
    }
  }
  try {
    return decode(payload);
  } catch {
    throw new BrowserAutomationClientFailure(
      "protocol",
      "Browser automation returned an invalid response.",
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
