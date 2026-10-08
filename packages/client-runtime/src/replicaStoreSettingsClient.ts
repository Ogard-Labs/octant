import {
  decodeReplicaStoreSettingsResult,
  decodeReplicaStoreSettingsView,
  type ReplicaStoreSettingsCommand,
  type ReplicaStoreSettingsResult,
  type ReplicaStoreSettingsView,
} from "@octant/contracts/replica-store-settings";
import { bindFetchPort } from "./bindFetchPort";

export interface ReplicaStoreSettingsClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ReplicaStoreSettingsClient {
  /** The store this host copies artifact versions to, and whether sync is on. */
  read(signal?: AbortSignal): Promise<ReplicaStoreSettingsView>;
  /** Change the store or the switch, or run Test connection. */
  execute(command: ReplicaStoreSettingsCommand): Promise<ReplicaStoreSettingsResult>;
}

export class ReplicaStoreSettingsClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ReplicaStoreSettingsClientFailure";
    this.status = status;
  }
}

/**
 * Client for Settings › Sync on this host.
 *
 * Store setup is host authority, so the client refuses any base URL that is
 * not loopback: a remote client never gets one and Settings says the section
 * is on the host machine. A bucket's key pair is sent once, inside the command
 * that saves it, and no answer carries it back.
 */
export function createReplicaStoreSettingsClient(
  options: ReplicaStoreSettingsClientOptions,
): ReplicaStoreSettingsClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const settingsUrl = new URL("/api/replica-store/settings", options.baseUrl).toString();
  const commandsUrl = new URL("/api/replica-store/commands", options.baseUrl).toString();

  async function send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
          "x-octant-window-capability": options.windowCapability,
        },
      });
    } catch {
      throw new ReplicaStoreSettingsClientFailure("Sync settings are unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "Sync settings are unavailable.";
      throw new ReplicaStoreSettingsClientFailure(message, response.status);
    }
    return body;
  }

  return {
    async read(signal) {
      const body = await send(settingsUrl, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeReplicaStoreSettingsView(body);
    },
    async execute(command) {
      const body = await send(commandsUrl, { method: "POST", body: JSON.stringify(command) });
      return decodeReplicaStoreSettingsResult(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ReplicaStoreSettingsClientFailure("Sync settings base URL is invalid.", 0);
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new ReplicaStoreSettingsClientFailure("Sync settings require a loopback host.", 0);
  }
}
