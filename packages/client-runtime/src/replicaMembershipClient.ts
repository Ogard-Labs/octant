import {
  decodeReplicaMembershipResult,
  decodeReplicaMembershipView,
  decodeReplicaRestoreResult,
  type ReplicaMembershipCommand,
  type ReplicaMembershipResult,
  type ReplicaMembershipView,
  type ReplicaRestoreCommand,
  type ReplicaRestoreResult,
} from "@octant/contracts/replica-entry";
import { bindFetchPort } from "./bindFetchPort";

export interface ReplicaMembershipClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ReplicaMembershipClient {
  /** Membership as this host holds it: no store call. A paired phone is refused. */
  read(signal?: AbortSignal): Promise<ReplicaMembershipView>;
  /** Runs one host-only membership command. A paired phone is refused. */
  execute(
    command: ReplicaMembershipCommand,
    signal?: AbortSignal,
  ): Promise<ReplicaMembershipResult>;
  /** Stops or resumes this host's restore of the replica's library. A paired phone is refused. */
  restore(command: ReplicaRestoreCommand, signal?: AbortSignal): Promise<ReplicaRestoreResult>;
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
  const commandsUrl = new URL("/api/replica-membership/commands", options.baseUrl).toString();
  const stateUrl = new URL("/api/replica-membership/state", options.baseUrl).toString();

  async function send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, init);
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
    return body;
  }

  return {
    async read(signal) {
      const body = await send(stateUrl, {
        method: "GET",
        headers: { "x-octant-window-capability": options.windowCapability },
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeReplicaMembershipView(body);
    },
    async execute(command, signal) {
      const body = await send(commandsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(command),
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeReplicaMembershipResult(body);
    },
    async restore(command, signal) {
      const body = await send(commandsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(command),
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeReplicaRestoreResult(body);
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
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new ReplicaMembershipClientFailure("Replica membership requires a loopback host.", 0);
  }
}
