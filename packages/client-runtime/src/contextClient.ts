import {
  decodeContextCommand,
  decodeContextInspectorRequest,
  type ContextCommand,
  ContextCommandResult,
  ContextFailure,
  type ContextInspectorRequest,
  ContextInspectorResult,
  ContextInspectorSnapshot,
} from "@octant/contracts/context-rpc";
import {
  decodeThreadExternalContentRequest,
  ThreadExternalContentClearOutcome,
  type ThreadExternalContentRequest,
  ThreadExternalContentState,
} from "@octant/contracts/content-provenance";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

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
  /**
   * Whether this client may read and clear a thread's outside-content mark.
   * True for a local window; the host refuses a paired device, so the client
   * does not offer it off a loopback host.
   */
  readonly externalContentAvailable: boolean;
  /**
   * The sources a thread took outside content from, with the version a clear
   * must name. A local window only.
   */
  readExternalContent(
    thread: ExternalContentThread,
    signal?: AbortSignal,
  ): Promise<ThreadExternalContentState>;
  /**
   * Records that the person reviewed what the thread read and takes its mark
   * away. A refusal (a turn in flight, a newer ingestion) is an outcome, not a
   * failure. A local window only.
   */
  clearExternalContent(
    thread: ExternalContentThread & { readonly expectedVersion: number },
    signal?: AbortSignal,
  ): Promise<ThreadExternalContentClearOutcome>;
}

export interface ExternalContentThread {
  readonly mode: ThreadExternalContentRequest["mode"];
  readonly threadId: string;
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
  const resolved = { ...options, fetch: bindFetchPort(options.fetch) };
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
  const externalContentAvailable = isLoopbackHttp(options.baseUrl);
  return {
    externalContentAvailable,
    async inspect(input, signal) {
      let request: ContextInspectorRequest;
      try {
        request = decodeContextInspectorRequest(input);
      } catch {
        throw protocol("Context request is invalid.");
      }
      const result = await post(
        resolved,
        "/api/context/inspect",
        request,
        signal,
        decodeInspectorAnswer,
        headers,
      );
      if (result.kind === "not-planned") {
        if (!sameSubject(result.subject, request.subject)) {
          throw protocol("Context service returned an invalid response.");
        }
        throw new ContextClientFailure("not-planned", "This thread has no context plan yet.");
      }
      const snapshot = result.snapshot;
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
        resolved,
        "/api/context/commands",
        command,
        signal,
        decodeHostAnswer(ContextCommandResult),
        headers,
      );
      // A compaction answers before it has changed anything, so it carries no
      // snapshot; its receipt arrives on the next inspection.
      if (result.kind === "compaction-started") {
        if (command.kind !== "compact-session" || result.compactionId !== command.compactionId) {
          throw protocol("Context service returned an invalid response.");
        }
        return result;
      }
      if (!sameSubject(result.snapshot.subject, command.subject)) {
        throw protocol("Context service returned an invalid response.");
      }
      acceptSequence(result.snapshot);
      return result;
    },
    async readExternalContent(thread, signal) {
      if (!externalContentAvailable) throw notOnThisHost();
      return post(
        resolved,
        "/api/thread-external-content",
        externalContentRequest({ kind: "read", mode: thread.mode, threadId: thread.threadId }),
        signal,
        decodeHostAnswer(ThreadExternalContentState),
        headers,
      );
    },
    async clearExternalContent(thread, signal) {
      if (!externalContentAvailable) throw notOnThisHost();
      return post(
        resolved,
        "/api/thread-external-content",
        externalContentRequest({
          kind: "clear",
          mode: thread.mode,
          threadId: thread.threadId,
          expectedVersion: thread.expectedVersion,
        }),
        signal,
        decodeHostAnswer(ThreadExternalContentClearOutcome),
        headers,
      );
    },
  };
}

function isLoopbackHttp(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function notOnThisHost(): ContextClientFailure {
  return new ContextClientFailure(
    "unavailable",
    "A thread's outside content is reviewed at a window on the host.",
  );
}

function externalContentRequest(input: unknown): ThreadExternalContentRequest {
  try {
    return decodeThreadExternalContentRequest(input);
  } catch {
    throw protocol("External-content request is invalid.");
  }
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
      const failure = decodeHostAnswer(ContextFailure)(payload);
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

/**
 * The inspector answer is a result with a `kind`, or a bare snapshot, as the
 * shared decoder reads it; this reads either one the way a client reads every
 * host answer.
 */
function decodeInspectorAnswer(input: unknown): ContextInspectorResult {
  if (typeof input === "object" && input !== null && "kind" in input) {
    return decodeHostAnswer(ContextInspectorResult)(input);
  }
  return { kind: "snapshot", snapshot: decodeHostAnswer(ContextInspectorSnapshot)(input) };
}
