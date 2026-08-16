import {
  decodeContextCommand,
  decodeContextCommandResult,
  decodeContextFailure,
  decodeContextInspectorRequest,
  decodeContextInspectorSnapshot,
  type ContextCommand,
  type ContextCommandResult,
  type ContextFailure,
  type ContextInspectorRequest,
  type ContextInspectorSnapshot,
} from "@octant/contracts/context-rpc";

export interface ContextClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ContextClient {
  inspect(
    request: ContextInspectorRequest,
    signal?: AbortSignal,
  ): Promise<ContextInspectorSnapshot>;
  execute(command: ContextCommand, signal?: AbortSignal): Promise<ContextCommandResult>;
}

export type ContextClientFailureCategory = ContextFailure["category"] | "interrupted" | "protocol";

export class ContextClientFailure extends Error {
  readonly category: ContextClientFailureCategory;

  constructor(category: ContextClientFailureCategory, message: string) {
    super(message);
    this.name = "ContextClientFailure";
    this.category = category;
  }
}

export function createContextClient(options: ContextClientOptions): ContextClient {
  const headers = {
    "content-type": "application/json",
    "x-octant-window-capability": options.windowCapability,
  };
  const acceptedSequences = new Map<string, number>();
  const acceptSequence = (snapshot: ContextInspectorSnapshot): void => {
    const key = subjectKey(snapshot.subject);
    const accepted = acceptedSequences.get(key);
    if (accepted !== undefined && snapshot.sequence < accepted) {
      throw protocol("Context service returned an invalid response.");
    }
    acceptedSequences.set(key, snapshot.sequence);
  };
  return {
    async inspect(input, signal) {
      let request: ContextInspectorRequest;
      try {
        request = decodeContextInspectorRequest(input);
      } catch {
        throw protocol("Context request is invalid.");
      }
      const snapshot = await post(
        options,
        "/api/context/inspect",
        request,
        signal,
        decodeContextInspectorSnapshot,
        headers,
      );
      if (
        !sameSubject(snapshot.subject, request.subject) ||
        (request.afterSequence !== undefined && snapshot.sequence < request.afterSequence)
      ) {
        throw protocol("Context service returned an invalid response.");
      }
      acceptSequence(snapshot);
      return snapshot;
    },
    async execute(input, signal) {
      let command: ContextCommand;
      try {
        command = decodeContextCommand(input);
      } catch {
        throw protocol("Context command is invalid.");
      }
      const result = await post(
        options,
        "/api/context/commands",
        command,
        signal,
        decodeContextCommandResult,
        headers,
      );
      if (!sameSubject(result.snapshot.subject, command.subject)) {
        throw protocol("Context service returned an invalid response.");
      }
      acceptSequence(result.snapshot);
      return result;
    },
  };
}

function subjectKey(subject: ContextInspectorRequest["subject"]): string {
  return `${subject.aggregateType}\u0000${subject.aggregateId}`;
}

async function post<T>(
  options: ContextClientOptions,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  decodeSuccess: (input: unknown) => T,
  headers: Readonly<Record<string, string>>,
): Promise<T> {
  let response: Response;
  try {
    response = await options.fetch(new URL(path, options.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) {
      throw new ContextClientFailure("interrupted", "Context request was interrupted.");
    }
    throw new ContextClientFailure("unavailable", "Octant Context service is unavailable.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw protocol("Context service returned an invalid response.");
  }
  if (!response.ok) {
    try {
      const failure = decodeContextFailure(payload);
      throw new ContextClientFailure(failure.category, failure.message);
    } catch (error) {
      if (error instanceof ContextClientFailure) throw error;
      throw protocol("Context service returned an invalid response.");
    }
  }
  try {
    return decodeSuccess(payload);
  } catch {
    throw protocol("Context service returned an invalid response.");
  }
}

function protocol(message: string): ContextClientFailure {
  return new ContextClientFailure("protocol", message);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function sameSubject(
  left: ContextInspectorRequest["subject"],
  right: ContextInspectorRequest["subject"],
): boolean {
  return left.aggregateType === right.aggregateType && left.aggregateId === right.aggregateId;
}
