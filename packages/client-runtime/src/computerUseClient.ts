import {
  decodeComputerUseApprovalDecisionRequest,
  decodeComputerUseFailure,
  decodeComputerUseSessionScope,
  decodeComputerUseSessionList,
  decodeComputerUseSessionView,
  decodeComputerUseStopRequest,
  type ComputerUseFailure,
  type ComputerUseApprovalDecisionRequest,
  type ComputerUseSessionScope,
  type ComputerUseSessionList,
  type ComputerUseSessionView,
  type ComputerUseStopRequest,
} from "@octant/contracts/computer-use";
import { sameToolActionAuthority } from "@octant/contracts/tool-actions";

export interface ComputerUseClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ComputerUseClient {
  readonly list: (signal?: AbortSignal) => Promise<ComputerUseSessionList>;
  readonly inspect: (
    request: ComputerUseSessionScope,
    signal?: AbortSignal,
  ) => Promise<ComputerUseSessionView>;
  readonly decide: (
    request: ComputerUseApprovalDecisionRequest,
    signal?: AbortSignal,
  ) => Promise<ComputerUseSessionView>;
  readonly stop: (
    request: ComputerUseStopRequest,
    signal?: AbortSignal,
  ) => Promise<ComputerUseSessionView>;
}

export class ComputerUseClientFailure extends Error {
  override readonly name = "ComputerUseClientFailure";

  constructor(
    readonly category: ComputerUseFailure["category"] | "interrupted" | "protocol",
    message: string,
  ) {
    super(message);
  }
}

export function createComputerUseClient(options: ComputerUseClientOptions): ComputerUseClient {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": options.windowCapability,
  };
  return {
    list: async (signal) => {
      const payload = await postJson(options, "/api/computer-use/sessions", {}, headers, signal);
      try {
        return decodeComputerUseSessionList(payload);
      } catch {
        throw new ComputerUseClientFailure(
          "protocol",
          "Computer-use service returned an invalid session list.",
        );
      }
    },
    inspect: async (input, signal) => {
      const request = decodeInput(
        input,
        decodeComputerUseSessionScope,
        "Computer-use inspection request is invalid.",
      );
      return await post(options, "/api/computer-use/inspect", request, request, headers, signal);
    },
    decide: async (input, signal) => {
      const request = decodeInput(
        input,
        decodeComputerUseApprovalDecisionRequest,
        "Computer-use approval decision is invalid.",
      );
      return await post(options, "/api/computer-use/approvals", request, request, headers, signal);
    },
    stop: async (input, signal) => {
      const request = decodeInput(
        input,
        decodeComputerUseStopRequest,
        "Computer-use stop request is invalid.",
      );
      return await post(options, "/api/computer-use/stop", request, request, headers, signal);
    },
  };
}

function decodeInput<T>(input: unknown, decode: (value: unknown) => T, message: string): T {
  try {
    return decode(input);
  } catch {
    throw new ComputerUseClientFailure("protocol", message);
  }
}

async function post(
  options: ComputerUseClientOptions,
  path: string,
  body: unknown,
  expected: ComputerUseSessionScope,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ComputerUseSessionView> {
  const payload = await postJson(options, path, body, headers, signal);
  let view: ComputerUseSessionView;
  try {
    view = decodeComputerUseSessionView(payload);
  } catch {
    throw new ComputerUseClientFailure(
      "protocol",
      "Computer-use service returned an invalid lifecycle view.",
    );
  }
  if (
    view.sessionId !== expected.sessionId ||
    view.threadId !== expected.threadId ||
    !sameToolActionAuthority(view.authority, expected.authority)
  ) {
    throw new ComputerUseClientFailure(
      "protocol",
      "Computer-use service returned a mismatched lifecycle view.",
    );
  }
  return view;
}

async function postJson(
  options: ComputerUseClientOptions,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    const base = new URL(options.baseUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      (base.hostname !== "127.0.0.1" && base.hostname !== "localhost" && base.hostname !== "::1")
    ) {
      throw new ComputerUseClientFailure("protocol", "Computer-use host URL is invalid.");
    }
    response = await options.fetch(new URL(path, base), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof ComputerUseClientFailure) throw error;
    if (signal?.aborted === true || isAbortError(error)) {
      throw new ComputerUseClientFailure("interrupted", "Computer-use request was interrupted.");
    }
    throw new ComputerUseClientFailure(
      "unavailable",
      "Octant computer-use service is unavailable.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ComputerUseClientFailure("protocol", "Computer-use service returned invalid JSON.");
  }
  if (!response.ok) {
    let failure: ComputerUseFailure;
    try {
      failure = decodeComputerUseFailure(payload);
    } catch {
      throw new ComputerUseClientFailure(
        "protocol",
        "Computer-use service returned an invalid failure.",
      );
    }
    throw new ComputerUseClientFailure(failure.category, failure.message);
  }
  return payload;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
