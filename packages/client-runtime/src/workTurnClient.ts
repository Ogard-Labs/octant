import {
  MAX_WORK_ATTACHMENT_BYTES,
  decodeCancelWorkTurnCommand,
  decodeWorkAttachmentId,
  decodeWorkAttachmentMediaType,
  decodeWorkAttachmentReference,
  decodeWorkThreadId,
  decodeWorkThreadTranscript,
  decodeWorkTurnCancelResult,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  decodeWorkTurnStreamFrame,
  decodeStartWorkThreadTurnCommand,
  type CancelWorkTurnCommand,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkTurnCancelResult,
  type WorkTurnLookupResult,
  type WorkTurnRequestId,
  type WorkTurnStreamFrame,
  type StartWorkThreadTurnCommand,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkTurnClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkTurnClient {
  startFirstTurn(command: StartWorkThreadTurnCommand): Promise<WorkTurnLookupResult>;
  lookupFirstTurn(requestId: WorkTurnRequestId): Promise<WorkTurnLookupResult>;
  cancelFirstTurn(command: CancelWorkTurnCommand): Promise<WorkTurnCancelResult>;
  transcript(threadId: WorkThreadId, signal?: AbortSignal): Promise<WorkThreadTranscript>;
  subscribe(
    threadId: WorkThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncGenerator<WorkTurnStreamFrame>;
  /**
   * Hand the host one image for a thread's next turn. The host answers with
   * the reference a `start-work-thread-turn` names by id; nothing about the
   * bytes is decided here.
   */
  putAttachment(input: {
    readonly threadId: WorkThreadId;
    readonly attachmentId: WorkAttachmentId;
    readonly displayName: string;
    readonly mediaType: WorkAttachmentMediaType;
    readonly bytes: Uint8Array;
  }): Promise<WorkAttachmentReference>;
  /** Drop a staged image the composer no longer carries. */
  discardAttachment(threadId: WorkThreadId, attachmentId: WorkAttachmentId): Promise<void>;
}

export class WorkTurnClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkTurnClientFailure";
    this.status = status;
  }
}

export function createWorkTurnClient(options: WorkTurnClientOptions): WorkTurnClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    async startFirstTurn(command) {
      let validated: StartWorkThreadTurnCommand;
      try {
        validated = decodeStartWorkThreadTurnCommand(command);
      } catch {
        throw new WorkTurnClientFailure("Work turn command is invalid.", 0);
      }
      return postJson(
        fetch,
        options,
        "/api/work/turns",
        validated,
        decodeWorkTurnLookupResult,
        "Work turn start failed.",
      );
    },
    async lookupFirstTurn(requestId) {
      let validated: WorkTurnRequestId;
      try {
        validated = decodeWorkTurnRequestId(requestId);
      } catch {
        throw new WorkTurnClientFailure("Work turn request id is invalid.", 0);
      }
      return getJson(
        fetch,
        options,
        `/api/work/turns/${validated}`,
        decodeWorkTurnLookupResult,
        "Work turn lookup failed.",
      );
    },
    async cancelFirstTurn(command) {
      let validated: CancelWorkTurnCommand;
      try {
        validated = decodeCancelWorkTurnCommand(command);
      } catch {
        throw new WorkTurnClientFailure("Work turn cancel command is invalid.", 0);
      }
      return postJson(
        fetch,
        options,
        "/api/work/turns/cancel",
        validated,
        decodeWorkTurnCancelResult,
        "Work turn cancel failed.",
      );
    },
    async transcript(threadId, signal) {
      return getJson(
        fetch,
        options,
        `/api/work/turns/transcript/${threadId}`,
        decodeWorkThreadTranscript,
        "Work transcript lookup failed.",
        signal,
      );
    },
    subscribe(threadId, afterSequence, signal) {
      try {
        decodeWorkThreadId(threadId);
        if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("cursor");
      } catch {
        return rejectedWorkStream(new WorkTurnClientFailure("Work turn stream is invalid.", 0));
      }
      const url = new URL(
        `/api/work/turns/stream/${encodeURIComponent(threadId)}`,
        options.baseUrl,
      );
      url.searchParams.set("afterSequence", String(afterSequence));
      return parseWorkTurnStream(
        fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          signal,
        }),
        threadId,
        afterSequence,
        signal,
      );
    },
    async putAttachment(input) {
      try {
        decodeWorkThreadId(input.threadId);
        decodeWorkAttachmentId(input.attachmentId);
        decodeWorkAttachmentMediaType(input.mediaType);
      } catch {
        throw new WorkTurnClientFailure("Work attachment is invalid.", 0);
      }
      if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_WORK_ATTACHMENT_BYTES) {
        throw new WorkTurnClientFailure("Work attachment is invalid.", 0);
      }
      if (input.displayName.trim().length === 0) {
        throw new WorkTurnClientFailure("Work attachment is invalid.", 0);
      }
      let response: Response;
      try {
        response = await fetch(new URL("/api/work/attachments", options.baseUrl).toString(), {
          method: "PUT",
          headers: {
            "content-type": input.mediaType,
            "x-octant-window-capability": options.windowCapability,
            "x-octant-work-thread-id": String(input.threadId),
            "x-octant-work-attachment-id": String(input.attachmentId),
            "x-octant-work-display-name": encodeURIComponent(input.displayName),
          },
          body: input.bytes as unknown as BodyInit,
        });
      } catch {
        throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
      }
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new WorkTurnClientFailure(
          responseMessage(payload, "Work attachment upload failed."),
          response.status,
        );
      }
      try {
        return decodeWorkAttachmentReference(payload);
      } catch {
        throw new WorkTurnClientFailure("Work turn service returned an invalid response.", 0);
      }
    },
    async discardAttachment(threadId, attachmentId) {
      try {
        decodeWorkThreadId(threadId);
        decodeWorkAttachmentId(attachmentId);
      } catch {
        throw new WorkTurnClientFailure("Work attachment is invalid.", 0);
      }
      const url = new URL("/api/work/attachments", options.baseUrl);
      url.searchParams.set("thread", String(threadId));
      url.searchParams.set("attachment", String(attachmentId));
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "DELETE",
          headers: { "x-octant-window-capability": options.windowCapability },
        });
      } catch {
        throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
      }
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => ({}));
        throw new WorkTurnClientFailure(
          responseMessage(payload, "Work attachment discard failed."),
          response.status,
        );
      }
    },
  };
}

async function* parseWorkTurnStream(
  responsePromise: Promise<Response>,
  threadId: WorkThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<WorkTurnStreamFrame> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    if (signal.aborted) return;
    throw new WorkTurnClientFailure("Work turn stream is unavailable.", 0);
  }
  if (!response.ok)
    throw new WorkTurnClientFailure("Work turn stream is unavailable.", response.status);
  if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson") {
    throw new WorkTurnClientFailure("Work turn stream response is invalid.", 0);
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let lastSequence = afterSequence;
  let frameCount = 0;
  const decodeLine = (line: string): WorkTurnStreamFrame => {
    if (encoder.encode(line).byteLength > 160 * 1024) {
      throw new WorkTurnClientFailure("Work turn stream frame is too large.", 0);
    }
    let frame: WorkTurnStreamFrame;
    try {
      frame = decodeWorkTurnStreamFrame(JSON.parse(line));
    } catch {
      throw new WorkTurnClientFailure("Work turn stream frame is invalid.", 0);
    }
    const cursorRegressed =
      frame.kind === "snapshot-required" ? false : frame.sequence <= lastSequence;
    if (String(frame.threadId) !== String(threadId) || cursorRegressed) {
      throw new WorkTurnClientFailure("Work turn stream cursor is invalid.", 0);
    }
    lastSequence = frame.sequence;
    frameCount += 1;
    if (frameCount > 512) {
      throw new WorkTurnClientFailure("Work turn stream exceeded its frame budget.", 0);
    }
    return frame;
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readWorkStreamChunk(reader, signal);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") yield decodeLine(line);
        newline = buffer.indexOf("\n");
      }
      if (encoder.encode(buffer).byteLength > 160 * 1024) {
        throw new WorkTurnClientFailure("Work turn stream frame is too large.", 0);
      }
    }
    const trailing = buffer.trim();
    if (trailing !== "") yield decodeLine(trailing);
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may already release the reader.
    }
  }
}

async function readWorkStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reader.cancel().then(() => resolve({ done: true, value: undefined as undefined }), reject);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function* rejectedWorkStream(error: Error): AsyncGenerator<WorkTurnStreamFrame> {
  throw error;
}

async function postJson<T>(
  fetch: typeof globalThis.fetch,
  options: WorkTurnClientOptions,
  path: string,
  body: unknown,
  decode: (value: unknown) => T,
  failureMessage: string,
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
    throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkTurnClientFailure(responseMessage(payload, failureMessage), response.status);
  }
  try {
    return decode(payload);
  } catch {
    throw new WorkTurnClientFailure("Work turn service returned an invalid response.", 0);
  }
}

async function getJson<T>(
  fetch: typeof globalThis.fetch,
  options: WorkTurnClientOptions,
  path: string,
  decode: (value: unknown) => T,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.baseUrl).toString(), {
      method: "GET",
      headers: { "x-octant-window-capability": options.windowCapability },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new WorkTurnClientFailure("Work turn service is unavailable.", 0);
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new WorkTurnClientFailure(responseMessage(payload, failureMessage), response.status);
  }
  try {
    return decode(payload);
  } catch {
    throw new WorkTurnClientFailure("Work turn service returned an invalid response.", 0);
  }
}

function responseMessage(body: unknown, fallback: string): string {
  return typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : fallback;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkTurnClientFailure("Work turn base URL is invalid.", 0);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new WorkTurnClientFailure("Work turn base URL must be loopback.", 0);
  }
}
