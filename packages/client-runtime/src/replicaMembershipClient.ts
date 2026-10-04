import {
  decodeReplicaMembershipResult,
  type ReplicaMembershipCommand,
  type ReplicaMembershipResult,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ReplicaMembershipClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ReplicaMembershipClient {
  /** Runs one host-only membership command. A paired phone is refused. */
  execute(
    command: ReplicaMembershipCommand,
    signal?: AbortSignal,
  ): Promise<ReplicaMembershipResult>;
}

export class ReplicaMembershipClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ReplicaMembershipClientFailure";
    this.status = status;
  }
}

/**
 * Client for the host-only replica membership surface.
 *
 * Store setup, join approval, and revocation are host authority. This client
 * only carries the window capability and returns the host's typed result, so
 * a renderer cannot widen membership or invent an approval.
 */
export function createReplicaMembershipClient(
  options: ReplicaMembershipClientOptions,
): ReplicaMembershipClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/replica-membership/commands", options.baseUrl).toString();

  return {
    async execute(command, signal) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new ReplicaMembershipClientFailure("Replica membership is unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Replica membership is unavailable.";
        throw new ReplicaMembershipClientFailure(message, response.status);
      }
      return decodeReplicaMembershipResult(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ReplicaMembershipClientFailure("Replica membership base URL is invalid.", 0);
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    throw new ReplicaMembershipClientFailure("Replica membership requires a loopback host.", 0);
  }
}
