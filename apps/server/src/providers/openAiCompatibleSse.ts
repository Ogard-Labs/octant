import type { ProviderFailure } from "@octant/contracts";

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
}

export interface SseDecodeLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly signal?: AbortSignal;
}

export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  limits: SseDecodeLimits,
): AsyncGenerator<SseFrame, void, void> {
  assertLimit(limits.maxFrameBytes);
  assertLimit(limits.maxBufferedBytes);
  const reader = stream.getReader();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  limits.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (isAborted(limits.signal)) throw interrupted();
      let result;
      try {
        result = await reader.read();
      } catch {
        if (isAborted(limits.signal)) throw interrupted();
        throw protocol("The provider stream could not be read.");
      }
      if (isAborted(limits.signal)) throw interrupted();
      if (result.done) break;
      pending = append(pending, result.value);

      let boundary = findBoundary(pending);
      while (boundary !== undefined) {
        if (boundary.start > limits.maxFrameBytes) throw frameOverflow();
        const frame = parseFrame(pending.subarray(0, boundary.start));
        pending = pending.slice(boundary.end);
        if (frame !== undefined) yield frame;
        boundary = findBoundary(pending);
      }
      if (pending.byteLength > limits.maxFrameBytes) throw frameOverflow();
      if (pending.byteLength > limits.maxBufferedBytes) {
        throw protocol("The provider stream buffer exceeded the configured size limit.");
      }
    }

    if (pending.byteLength > 0) {
      if (pending.byteLength > limits.maxFrameBytes) throw frameOverflow();
      const frame = parseFrame(pending);
      if (frame !== undefined) yield frame;
    }
  } finally {
    limits.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseFrame(bytes: Uint8Array<ArrayBufferLike>): SseFrame | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw protocol("The provider stream contained invalid UTF-8.");
  }
  const data: string[] = [];
  let event: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { ...(event === undefined ? {} : { event }), data: data.join("\n") };
}

function findBoundary(
  bytes: Uint8Array<ArrayBufferLike>,
): { readonly start: number; readonly end: number } | undefined {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) {
      return { start: index, end: index + 2 };
    }
    if (
      bytes[index] === 0x0d &&
      bytes[index + 1] === 0x0a &&
      bytes[index + 2] === 0x0d &&
      bytes[index + 3] === 0x0a
    ) {
      return { start: index, end: index + 4 };
    }
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0d && bytes[index + 2] === 0x0a) {
      return { start: index, end: index + 3 };
    }
  }
  return undefined;
}

function append(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SSE limits must be positive integers.");
  }
}

function frameOverflow(): ProviderFailure {
  return protocol("The provider stream event exceeded the configured size limit.");
}

function interrupted(): ProviderFailure {
  return { category: "interrupted", message: "The provider stream was cancelled." };
}

function protocol(message: string): ProviderFailure {
  return { category: "protocol", message };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
