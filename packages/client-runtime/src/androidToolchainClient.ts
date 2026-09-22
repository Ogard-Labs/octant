import {
  decodeAndroidRpcEnvelope,
  type AndroidArtifactRequest,
  type AndroidScreenStreamRequest,
  type AndroidCancelRequest,
  type AndroidDiscoverySnapshot,
  type AndroidSnapshotRequest,
} from "@octant/contracts/android-toolchain-rpc";
import { bindFetchPort } from "./bindFetchPort";
import type {
  AndroidDiscoveryRequest,
  AndroidEmulatorEvidence,
  AndroidEmulatorRequest,
  AndroidRuntimeSnapshot,
  AndroidToolchainFailure,
} from "@octant/contracts/android-toolchain";

export interface AndroidToolchainClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export type AndroidScreenshotReadResult =
  | { readonly status: "succeeded"; readonly blob: Blob }
  | {
      readonly status: "failed";
      readonly kind: AndroidToolchainClientFailureCategory;
      readonly message: string;
    };

export type AndroidScreenWatchResult =
  | {
      readonly status: "watching";
      readonly screen: { readonly width: number; readonly height: number };
      readonly frames: AsyncIterable<Uint8Array>;
    }
  | {
      readonly status: "failed";
      readonly kind: AndroidToolchainClientFailureCategory;
      readonly message: string;
    };

export interface AndroidToolchainClient {
  discover(
    request: AndroidDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<AndroidDiscoverySnapshot>;
  execute(request: AndroidEmulatorRequest, signal?: AbortSignal): Promise<AndroidEmulatorEvidence>;
  cancel(request: AndroidCancelRequest, signal?: AbortSignal): Promise<boolean>;
  snapshot(request: AndroidSnapshotRequest, signal?: AbortSignal): Promise<AndroidRuntimeSnapshot>;
  readScreenshot(
    request: AndroidArtifactRequest,
    signal?: AbortSignal,
  ): Promise<AndroidScreenshotReadResult>;
  watchScreen(
    request: AndroidScreenStreamRequest,
    signal?: AbortSignal,
  ): Promise<AndroidScreenWatchResult>;
}

export type AndroidToolchainClientFailureCategory =
  | AndroidToolchainFailure["category"]
  | "interrupted"
  | "protocol";

export class AndroidToolchainClientFailure extends Error {
  constructor(
    readonly category: AndroidToolchainClientFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = "AndroidToolchainClientFailure";
  }
}

export function createAndroidToolchainClient(
  options: AndroidToolchainClientOptions,
): AndroidToolchainClient {
  const resolved = { ...options, fetch: bindFetchPort(options.fetch) };
  return {
    discover: async (request, signal) => {
      const reply = await post(resolved, { kind: "android-discovery-request", request }, signal);
      if (reply.kind !== "android-discovery-snapshot") throw protocol();
      return reply.snapshot;
    },
    execute: async (request, signal) => {
      const reply = await post(resolved, { kind: "android-action-request", request }, signal);
      if (reply.kind !== "android-action-evidence") throw protocol();
      return reply.evidence;
    },
    cancel: async (request, signal) => {
      const reply = await post(resolved, request, signal);
      if (reply.kind !== "android-cancelled") throw protocol();
      return reply.cancelled;
    },
    snapshot: async (request, signal) => {
      const reply = await post(resolved, request, signal);
      if (reply.kind !== "android-runtime-snapshot") throw protocol();
      return reply.snapshot;
    },
    readScreenshot: async (request, signal) => readPng(resolved, request, signal),
    watchScreen: async (request, signal) => watchScreen(resolved, request, signal),
  };
}

const SCREEN_HEADER = "x-octant-simulator-screen";
const MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;

async function watchScreen(
  options: AndroidToolchainClientOptions,
  body: AndroidScreenStreamRequest,
  signal?: AbortSignal,
): Promise<AndroidScreenWatchResult> {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/android/screen-stream", options.baseUrl), {
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
        ? "Android toolchain request was interrupted."
        : "Android toolchain service is unavailable.",
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
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
  } else {
    try {
      const reply = decodeAndroidRpcEnvelope(await response.json());
      if (reply.kind === "android-failure") {
        return { status: "failed", kind: reply.failure.category, message: reply.failure.message };
      }
    } catch {
      // Falls through to the protocol failure below.
    }
  }
  return {
    status: "failed",
    kind: "protocol",
    message: "Android toolchain service returned an invalid response.",
  };
}

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
    // An aborted or broken stream ends the view.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readPng(
  options: AndroidToolchainClientOptions,
  body: AndroidArtifactRequest,
  signal?: AbortSignal,
): Promise<AndroidScreenshotReadResult> {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/android/artifacts", options.baseUrl), {
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
        ? "Android toolchain request was interrupted."
        : "Android toolchain service is unavailable.",
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
          ? "Android screenshot read was interrupted."
          : "Android screenshot bytes are unavailable.",
      };
    }
  }
  let reply;
  try {
    reply = decodeAndroidRpcEnvelope(await response.json());
  } catch {
    return {
      status: "failed",
      kind: "protocol",
      message: "Android toolchain service returned an invalid response.",
    };
  }
  if (reply.kind === "android-failure") {
    return {
      status: "failed",
      kind: reply.failure.category,
      message: reply.failure.message,
    };
  }
  return {
    status: "failed",
    kind: "protocol",
    message: "Android toolchain service returned an invalid response.",
  };
}

async function post(options: AndroidToolchainClientOptions, body: unknown, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await options.fetch(new URL("/api/android/toolchain", options.baseUrl), {
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
      throw new AndroidToolchainClientFailure(
        "interrupted",
        "Android toolchain request was interrupted.",
      );
    }
    throw new AndroidToolchainClientFailure(
      "unavailable",
      "Android toolchain service is unavailable.",
    );
  }
  let reply;
  try {
    reply = decodeAndroidRpcEnvelope(await response.json());
  } catch {
    throw protocol();
  }
  if (reply.kind === "android-failure") {
    throw new AndroidToolchainClientFailure(reply.failure.category, reply.failure.message);
  }
  if (!response.ok) throw protocol();
  return reply;
}

function protocol(): AndroidToolchainClientFailure {
  return new AndroidToolchainClientFailure(
    "protocol",
    "Android toolchain service returned an invalid response.",
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}
