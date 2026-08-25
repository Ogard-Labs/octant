import {
  decodeChatEventFrame,
  MAX_CHAT_NDJSON_LINE_BYTES,
  type ChatEventFrame,
  type ChatThreadId,
} from "@octant/contracts";

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export class ChatNdjsonFailure extends Error {
  readonly category: "unavailable" | "invalid";

  constructor(category: ChatNdjsonFailure["category"], message: string) {
    super(message);
    this.name = "ChatNdjsonFailure";
    this.category = category;
  }
}

/**
 * Iterate Chat event NDJSON from an already-opened Response body.
 * Shared by local ChatClient and mobile remote subscribe.
 */
export async function* iterateChatEventNdjson(
  response: Response,
  threadId: ChatThreadId,
  afterSequence: number,
  signal: AbortSignal,
): AsyncGenerator<ChatEventFrame> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferByteLength = 0;
  let lastSequence = afterSequence;
  const releaseReader = async () => {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation races while tearing down the stream.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore double-release while tearing down the stream.
    }
  };
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await readStreamChunk(reader, signal);
      if (next.done) break;
      const decodedChunk = decoder.decode(next.value, { stream: true });
      buffer += decodedChunk;
      bufferByteLength += utf8ByteLength(decodedChunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        bufferByteLength -= utf8ByteLength(line) + 1;
        if (line.length > 0) {
          const decoded = decodeReplayLine(
            line,
            threadId,
            () => lastSequence,
            (value) => {
              lastSequence = value;
            },
          );
          yield decoded;
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (bufferByteLength > MAX_CHAT_NDJSON_LINE_BYTES) {
        throw malformedNdjson();
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const decoded = decodeReplayLine(
        trailing,
        threadId,
        () => lastSequence,
        (value) => {
          lastSequence = value;
        },
      );
      yield decoded;
    }
  } finally {
    await releaseReader();
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reader.cancel().then(
        () => resolve({ done: true, value: undefined as undefined }),
        (error) => reject(error),
      );
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

function decodeReplayLine(
  line: string,
  threadId: ChatThreadId,
  readLastSequence: () => number,
  writeLastSequence: (value: number) => void,
): ChatEventFrame {
  if (utf8ByteLength(line) > MAX_CHAT_NDJSON_LINE_BYTES) {
    throw malformedNdjson();
  }
  let frame: ChatEventFrame;
  try {
    frame = decodeChatEventFrame(JSON.parse(line));
  } catch {
    throw malformedNdjson();
  }
  if (String(frame.threadId) !== String(threadId)) {
    throw malformedNdjson();
  }
  // Sequences are journal-wide global sequences, so per-thread frames are
  // legitimately sparse whenever other aggregates append events in between.
  // Only regressions and duplicates indicate a malformed replay.
  if (frame.sequence <= readLastSequence()) {
    throw malformedNdjson();
  }
  writeLastSequence(frame.sequence);
  return frame;
}

function malformedNdjson(): ChatNdjsonFailure {
  return new ChatNdjsonFailure("unavailable", "Chat service returned an invalid response.");
}
