import {
  decodeReplicaSyncStatusView,
  type ReplicaSyncStatusView,
} from "@octant/contracts/replica-entry";
import { bindFetchPort } from "./bindFetchPort";

export interface ReplicaSyncStatusClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability?: string;
}

export type ReplicaSyncStatusRead =
  | { readonly status: "ready"; readonly view: ReplicaSyncStatusView }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

export interface ReplicaSyncStatusClient {
  read(signal?: AbortSignal): Promise<ReplicaSyncStatusRead>;
}

/**
 * Read-only sync status for a client that is not on the host: a paired phone
 * or a remote window. It carries nothing a caller could act on; setting up,
 * joining, and revoking stay on the host.
 */
export function createReplicaSyncStatusClient(
  options: ReplicaSyncStatusClientOptions,
): ReplicaSyncStatusClient {
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/replica-sync/status", options.baseUrl).toString();
  return {
    async read(signal) {
      const headers: Record<string, string> = {};
      if (options.windowCapability !== undefined && options.windowCapability.length > 0) {
        headers["x-octant-window-capability"] = options.windowCapability;
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { status: "unavailable" };
      }
      if (response.status === 401 || response.status === 403) return { status: "refused" };
      if (!response.ok) return { status: "unavailable" };
      try {
        return { status: "ready", view: decodeReplicaSyncStatusView(await response.json()) };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
