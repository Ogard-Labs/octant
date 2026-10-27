import { decodeHostAnswer } from "@octant/contracts";
import {
  CodeDebugApprovalResult,
  CodeDebugConfigurationsResult,
  CodeDebugSessionResult,
  CodeDebugStartResult,
  decodeCodeDebugApprovalRequest,
  decodeCodeDebugConfigurationsRequest,
  decodeCodeDebugSessionCall,
  decodeCodeDebugStartRequest,
  type CodeDebugApprovalRequest,
  type CodeDebugConfigurationsRequest,
  type CodeDebugSessionCall,
  type CodeDebugStartRequest,
} from "@octant/contracts/code-debug";
import { bindFetchPort } from "./bindFetchPort";

export interface CodeDebugClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/**
 * The Run and debug panel's transport. The host decides everything, and its
 * refusals arrive as answers. A request the host does not answer with one
 * (a paired device the routes turn away, a host that cannot be reached, a
 * request the host found invalid) is a {@link CodeDebugClientFailure}.
 */
export interface CodeDebugClient {
  configurations(request: CodeDebugConfigurationsRequest): Promise<CodeDebugConfigurationsResult>;
  approve(request: CodeDebugApprovalRequest): Promise<CodeDebugApprovalResult>;
  start(request: CodeDebugStartRequest): Promise<CodeDebugStartResult>;
  session(call: CodeDebugSessionCall): Promise<CodeDebugSessionResult>;
}

/**
 * Why a request got no answer. `local-only`: the host answered 403, as it
 * does to a paired device, because debugging is the person's act at the
 * machine. `unreachable`: no answer arrived. `rejected`: any other failure.
 */
export class CodeDebugClientFailure extends Error {
  readonly kind: "local-only" | "unreachable" | "rejected";

  constructor(kind: CodeDebugClientFailure["kind"], message: string) {
    super(message);
    this.name = "CodeDebugClientFailure";
    this.kind = kind;
  }
}

const decodeConfigurations = decodeHostAnswer(CodeDebugConfigurationsResult);
const decodeApproval = decodeHostAnswer(CodeDebugApprovalResult);
const decodeStart = decodeHostAnswer(CodeDebugStartResult);
const decodeSession = decodeHostAnswer(CodeDebugSessionResult);

export function createCodeDebugClient(options: CodeDebugClientOptions): CodeDebugClient {
  validateBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  async function post<T>(
    path: string,
    body: unknown,
    decodeAnswer: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new CodeDebugClientFailure("unreachable", "The host could not be reached.");
    }
    const answer: unknown = await response.json().catch(() => undefined);
    if (response.status === 403) {
      throw new CodeDebugClientFailure("local-only", messageFrom(answer));
    }
    if (!response.ok) throw new CodeDebugClientFailure("rejected", messageFrom(answer));
    try {
      return decodeAnswer(answer);
    } catch {
      throw new CodeDebugClientFailure("rejected", "The host's answer could not be read.");
    }
  }

  // Each request is decoded before it leaves, so a malformed one is refused
  // here rather than sent for the host to refuse.
  const checked = <T>(decode: (value: unknown) => T, value: unknown): T => {
    try {
      return decode(value);
    } catch {
      throw new CodeDebugClientFailure("rejected", "The debug request is invalid.");
    }
  };

  return {
    configurations: async (request) =>
      post(
        "/api/code/debug/configurations",
        checked(decodeCodeDebugConfigurationsRequest, request),
        decodeConfigurations,
      ),
    approve: async (request) =>
      post(
        "/api/code/debug/approvals",
        checked(decodeCodeDebugApprovalRequest, request),
        decodeApproval,
      ),
    start: async (request) =>
      post("/api/code/debug/start", checked(decodeCodeDebugStartRequest, request), decodeStart),
    session: async (call) =>
      post("/api/code/debug/session", checked(decodeCodeDebugSessionCall, call), decodeSession),
  };
}

function messageFrom(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : "The debug request failed.";
}

/** Loopback may be plain HTTP; any other host must be HTTPS, which protects the window capability. */
function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CodeDebugClientFailure("rejected", "Debug base URL is invalid.");
  }
  const host = url.hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (
    loopback ? url.protocol !== "http:" && url.protocol !== "https:" : url.protocol !== "https:"
  ) {
    throw new CodeDebugClientFailure(
      "rejected",
      "Debug base URL must be loopback or an HTTPS host.",
    );
  }
}
