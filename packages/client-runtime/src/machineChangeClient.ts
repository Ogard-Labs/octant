import {
  decodeMachineChangeFrame,
  type MachineChangeFrame,
} from "@octant/contracts/machine-changes";
import { bindFetchPort } from "./bindFetchPort";

export interface MachineChangeClient {
  subscribe(afterSequence: number, signal: AbortSignal): AsyncGenerator<MachineChangeFrame>;
}

export function createMachineChangeClient(options: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}): MachineChangeClient {
  validateBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    subscribe(afterSequence, signal) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        return rejected(new Error("Machine change cursor is invalid."));
      }
      const url = new URL("/api/machine/changes", options.baseUrl);
      url.searchParams.set("afterSequence", String(afterSequence));
      return parseFrames(
        fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          signal,
        }),
        afterSequence,
        signal,
      );
    },
  };
}

async function* parseFrames(
  responsePromise: Promise<Response>,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<MachineChangeFrame> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    if (signal.aborted) return;
    throw new Error("Machine change stream is unavailable.");
  }
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";", 1)[0] !== "application/x-ndjson"
  ) {
    throw new Error("Machine change stream is unavailable.");
  }
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = afterSequence;
  const decodeLine = (line: string): MachineChangeFrame => {
    let frame: MachineChangeFrame;
    try {
      frame = decodeMachineChangeFrame(JSON.parse(line));
    } catch {
      throw new Error("Machine change stream frame is invalid.");
    }
    if (frame.kind === "changed" && frame.sequence <= cursor) {
      throw new Error("Machine change stream cursor regressed.");
    }
    cursor = frame.sequence;
    return frame;
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readChunk(reader, signal);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > 16 * 1024) {
        throw new Error("Machine change stream frame is too large.");
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== "") yield decodeLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim() !== "") yield decodeLine(buffer.trim());
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may already release the reader.
    }
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reader.cancel().then(() => resolve({ done: true, value: undefined as undefined }), reject);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function* rejected(error: Error): AsyncGenerator<MachineChangeFrame> {
  throw error;
}

function validateBaseUrl(value: string): void {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (!local && url.protocol !== "https:") throw new Error("Machine change URL is invalid.");
}
