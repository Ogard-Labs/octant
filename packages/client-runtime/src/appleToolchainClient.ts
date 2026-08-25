import {
  decodeAppleRpcEnvelope,
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

export interface AppleToolchainClient {
  discover(request: AppleDiscoveryRequest, signal?: AbortSignal): Promise<AppleDiscoverySnapshot>;
  execute(request: AppleActionRequest, signal?: AbortSignal): Promise<AppleBuildEvidence>;
  cancel(request: AppleCancelRequest, signal?: AbortSignal): Promise<boolean>;
  snapshot(request: AppleSnapshotRequest, signal?: AbortSignal): Promise<AppleRuntimeSnapshot>;
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
