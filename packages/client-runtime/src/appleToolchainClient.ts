import {
  decodeAppleRpcEnvelope,
  type AppleArtifactRequest,
  type AppleScreenStreamRequest,
  type AppleCancelRequest,
  type AppleDiscoverySnapshot,
  type AppleSnapshotRequest,
} from "@octant/contracts/apple-toolchain-rpc";
import { bindFetchPort } from "./bindFetchPort";
import type {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleRuntimeSnapshot,
  AppleToolchainFailure,
} from "@octant/contracts/apple-toolchain";

export interface AppleToolchainClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export type AppleScreenshotReadResult =
  | { readonly status: "succeeded"; readonly blob: Blob }
  | {
      readonly status: "failed";
      readonly kind: AppleToolchainClientFailureCategory;
      readonly message: string;
    };

export type AppleScreenWatchResult =
  | {
      readonly status: "watching";
      /** The device's screen in pixels; a tap is a point in this space. */
      readonly screen: { readonly width: number; readonly height: number };
      /** One JPEG per change of the screen. Ends when the host stops or `signal` aborts. */
      readonly frames: AsyncIterable<Uint8Array>;
    }
  | {
      readonly status: "failed";
      readonly kind: AppleToolchainClientFailureCategory;
      readonly message: string;
    };

export interface AppleToolchainClient {
  discover(request: AppleDiscoveryRequest, signal?: AbortSignal): Promise<AppleDiscoverySnapshot>;
  execute(request: AppleActionRequest, signal?: AbortSignal): Promise<AppleBuildEvidence>;
  cancel(request: AppleCancelRequest, signal?: AbortSignal): Promise<boolean>;
  snapshot(request: AppleSnapshotRequest, signal?: AbortSignal): Promise<AppleRuntimeSnapshot>;
  readScreenshot(
    request: AppleArtifactRequest,
    signal?: AbortSignal,
  ): Promise<AppleScreenshotReadResult>;
  watchScreen(
    request: AppleScreenStreamRequest,
    signal?: AbortSignal,
  ): Promise<AppleScreenWatchResult>;
}

export type AppleToolchainClientFailureCategory =
  | AppleToolchainFailure["category"]
  | "interrupted"
  | "protocol";

export class AppleToolchainClientFailure extends Error {
  constructor(
    readonly category: AppleToolchainClientFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "AppleToolchainClientFailure";
  }
}

export function createAppleToolchainClient(
  options: AppleToolchainClientOptions,
): AppleToolchainClient {
  const resolved = { ...options, fetch: bindFetchPort(options.fetch) };
  return {
    discover: async (request, signal) => {
      const reply = await post(resolved, { kind: "apple-discovery-request", request }, signal);
      if (reply.kind !== "apple-discovery-snapshot") throw protocol();
      return reply.snapshot;
    },
    execute: async (request, signal) => {
      const reply = await post(resolved, { kind: "apple-action-request", request }, signal);
      if (reply.kind !== "apple-action-evidence") throw protocol();
      return reply.evidence;
    },
    cancel: async (request, signal) => {
      const reply = await post(resolved, request, signal);
      if (reply.kind !== "apple-cancelled") throw protocol();
      return reply.cancelled;
    },
    snapshot: async (request, signal) => {
      const reply = await post(resolved, request, signal);
      if (reply.kind !== "apple-runtime-snapshot") throw protocol();
      return reply.snapshot;
    },
    readScreenshot: async (request, signal) => readPng(resolved, request, signal),
    watchScreen: async (request, signal) => watchScreen(resolved, request, signal),
  };
}

const SCREEN_HEADER = "x-octant-simulator-screen";
/** A full-size capture is a few megabytes as PNG; no JPEG frame comes near this. */
const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;

async function watchScreen(
  options: AppleToolchainClientOptions,
  body: AppleScreenStreamRequest,
  signal?: AbortSignal,
): Promise<AppleScreenWatchResult> {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/apple/screen-stream", options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const interrupted = signal?.aborted || isAbortError(error);
    return {
      status: "failed",
      kind: interrupted ? "interrupted" : "unavailable",
      message: interrupted
        ? "Apple toolchain request was interrupted."
        : "Apple toolchain service is unavailable.",
    };
  }
  const size = /^(\d{1,5})x(\d{1,5})$/.exec(response.headers.get(SCREEN_HEADER) ?? "");
  if (response.ok && response.body !== null && size !== null) {
    return {
      status: "watching",
      screen: { width: Number(size[1]), height: Number(size[2]) },
      frames: framesOf(response.body),
    };
  }
  try {
    const reply = decodeAppleRpcEnvelope(await response.json());
    if (reply.kind === "apple-failure") {
      return { status: "failed", kind: reply.failure.category, message: reply.failure.message };
    }
  } catch {
    // Falls through to the protocol failure below.
  }
  return {
    status: "failed",
    kind: "protocol",
    message: "Apple toolchain service returned an invalid response.",
  };
}

/**
 * Splits the host's byte stream into frames: each is a 4-byte big-endian
 * length and that many bytes of JPEG. Network chunks fall anywhere, so a frame
 * is yielded only once all of it has arrived; a length no screen could have
 * ends the stream rather than growing a buffer to meet it.
 */
async function* framesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffered = new Uint8Array(0);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      const joined = new Uint8Array(buffered.length + next.value.length);
      joined.set(buffered);
      joined.set(next.value, buffered.length);
      buffered = joined;
      while (buffered.length >= 4) {
        const length = new DataView(buffered.buffer, buffered.byteOffset, 4).getUint32(0);
        if (length > MAXIMUM_FRAME_BYTES) return;
        if (buffered.length < length + 4) break;
        yield buffered.slice(4, length + 4);
        buffered = buffered.slice(length + 4);
      }
    }
  } catch {
    // An aborted or broken stream ends the view; the caller sees no more frames.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readPng(
  options: AppleToolchainClientOptions,
  body: AppleArtifactRequest,
  signal?: AbortSignal,
): Promise<AppleScreenshotReadResult> {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/apple/artifacts", options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const interrupted = signal?.aborted || isAbortError(error);
    return {
      status: "failed",
      kind: interrupted ? "interrupted" : "unavailable",
      message: interrupted
        ? "Apple toolchain request was interrupted."
        : "Apple toolchain service is unavailable.",
    };
  }
  if (response.ok && response.headers.get("content-type") === "image/png") {
    try {
      return { status: "succeeded", blob: await response.blob() };
    } catch (error) {
      const interrupted = signal?.aborted || isAbortError(error);
      return {
        status: "failed",
        kind: interrupted ? "interrupted" : "unavailable",
        message: interrupted
          ? "Apple screenshot read was interrupted."
          : "Apple screenshot bytes are unavailable.",
      };
    }
  }
  let reply;
  try {
    reply = decodeAppleRpcEnvelope(await response.json());
  } catch {
    return {
      status: "failed",
      kind: "protocol",
      message: "Apple toolchain service returned an invalid response.",
    };
  }
  if (reply.kind === "apple-failure") {
    return {
      status: "failed",
      kind: reply.failure.category,
      message: reply.failure.message,
    };
  }
  return {
    status: "failed",
    kind: "protocol",
    message: "Apple toolchain service returned an invalid response.",
  };
}

async function post(options: AppleToolchainClientOptions, body: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/apple/toolchain", options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw new AppleToolchainClientFailure(
        "interrupted",
        "Apple toolchain request was interrupted.",
      );
    }
    throw new AppleToolchainClientFailure("unavailable", "Apple toolchain service is unavailable.");
  }
  let reply;
  try {
    reply = decodeAppleRpcEnvelope(await response.json());
  } catch {
    throw protocol();
  }
  if (reply.kind === "apple-failure") {
    throw new AppleToolchainClientFailure(reply.failure.category, reply.failure.message);
  }
  if (!response.ok) throw protocol();
  return reply;
}

function protocol(): AppleToolchainClientFailure {
  return new AppleToolchainClientFailure(
    "protocol",
    "Apple toolchain service returned an invalid response.",
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
