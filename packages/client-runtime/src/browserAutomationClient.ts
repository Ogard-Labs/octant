import {
  decodeBrowserActionCommand,
  decodeBrowserContextCancelCommand,
  decodeBrowserContextCreateCommand,
  decodeBrowserContextInspectCommand,
  decodeBrowserContextStopCommand,
  decodeBrowserThreadContextCommand,
  decodeBrowserThreadInspectCommand,
  decodeBrowserThreadScopeRequest,
  type BrowserActionCommand,
  BrowserAutomationSnapshot,
  type BrowserContextCancelCommand,
  type BrowserContextCreateCommand,
  type BrowserContextInspectCommand,
  type BrowserContextStopCommand,
  BrowserThreadScope,
  type BrowserThreadContextCommand,
  type BrowserThreadInspectCommand,
  type BrowserThreadScopeRequest,
  decodeBrowserToolApprovalDecision,
  type BrowserToolApprovalDecision,
  BrowserToolApprovalList,
} from "@octant/contracts/browser-automation-rpc";
import { BrowserAutomationFailure } from "@octant/contracts/browser-automation";
import {
  decodeBrowserCaptureImageCommand,
  decodeBrowserCaptureTakeCommand,
  decodeBrowserCapturesCommand,
  BrowserCaptureImage,
  type BrowserCaptureImageCommand,
  type BrowserCaptureTakeCommand,
  type BrowserCapturesCommand,
  BrowserCapturesResponse,
} from "@octant/contracts/browser-capture";
import {
  BrowserProfilesResult,
  decodeBrowserProfilesCommand,
  type BrowserProfilesCommand,
} from "@octant/contracts/browser-profiles";
import { decodeHostAnswer } from "@octant/contracts";

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
    input: BrowserThreadInspectCommand,
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
  /** The thread's kept screenshots, newest first. */
  listCaptures?(
    input: BrowserCapturesCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCapturesResponse>;
  readCapture?(
    input: BrowserCaptureImageCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCaptureImage>;
  /** The person's Screenshot control: take a screenshot and keep it as a capture. */
  takeCapture?(
    input: BrowserCaptureTakeCommand,
    signal?: AbortSignal,
  ): Promise<BrowserAutomationSnapshot>;
  listApprovals?(signal?: AbortSignal): Promise<BrowserToolApprovalList>;
  decideApproval?(decision: BrowserToolApprovalDecision): Promise<boolean>;
  /**
   * Sign out of, or list, the stored Browser profiles. A refusal is a result,
   * so the pane can say in words why a profile was not cleared.
   */
  manageProfiles?(
    command: BrowserProfilesCommand,
    signal?: AbortSignal,
  ): Promise<BrowserProfilesResult>;
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
        decodeHostAnswer(BrowserThreadScope),
        signal,
      ),
    create: (input, signal) =>
      post(
        options,
        "/api/browser/contexts",
        decodeBrowserContextCreateCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    inspect: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/inspect",
        decodeBrowserContextInspectCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    inspectThread: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/current",
        decodeBrowserThreadInspectCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    releaseThread: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/release",
        decodeBrowserThreadContextCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    act: (input, signal) =>
      post(
        options,
        "/api/browser/actions",
        decodeBrowserActionCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    cancel: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/cancel",
        decodeBrowserContextCancelCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    stop: (input, signal) =>
      post(
        options,
        "/api/browser/contexts/stop",
        decodeBrowserContextStopCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    listCaptures: (input, signal) =>
      post(
        options,
        "/api/browser/captures",
        decodeBrowserCapturesCommand(input),
        decodeHostAnswer(BrowserCapturesResponse),
        signal,
      ),
    readCapture: (input, signal) =>
      post(
        options,
        "/api/browser/captures/image",
        decodeBrowserCaptureImageCommand(input),
        decodeHostAnswer(BrowserCaptureImage),
        signal,
      ),
    takeCapture: (input, signal) =>
      post(
        options,
        "/api/browser/captures/take",
        decodeBrowserCaptureTakeCommand(input),
        decodeHostAnswer(BrowserAutomationSnapshot),
        signal,
      ),
    manageProfiles: (command, signal) =>
      post(
        options,
        "/api/browser/profiles",
        decodeBrowserProfilesCommand(command),
        decodeHostAnswer(BrowserProfilesResult),
        signal,
      ),
    listApprovals: (signal) =>
      post(
        options,
        "/api/browser/approvals",
        { kind: "list" },
        decodeHostAnswer(BrowserToolApprovalList),
        signal,
      ),
    decideApproval: async (decision) => {
      const validated = decodeBrowserToolApprovalDecision(decision);
      const response = await post(
        options,
        "/api/browser/approvals",
        { kind: "decide", ...validated },
        (value) => {
          const accepted =
            typeof value === "object" && value !== null && Object.keys(value).length === 1
              ? (value as { accepted?: unknown }).accepted
              : undefined;
          if (typeof accepted !== "boolean") throw new Error("invalid");
          return accepted;
        },
        undefined,
        // The host answers 409 `{ accepted: false }` for a request that expired
        // or that another window already answered: a refusal, not a failure.
        409,
      );
      return response;
    },
  };
}

async function post<T>(
  options: BrowserAutomationClientOptions,
  path: string,
  body: unknown,
  decode: (input: unknown) => T,
  signal: AbortSignal | undefined,
  refusalStatus?: number,
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
  if (!response.ok && response.status !== refusalStatus) {
    try {
      const failure = decodeHostAnswer(BrowserAutomationFailure)(payload);
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
