import {
  decodeHostResourceSnapshot,
  type HostResourceSnapshot,
} from "@octant/contracts/host-resources";
import { bindFetchPort } from "./bindFetchPort";

/**
 * Read-only load snapshot for the host this window is talking to.
 * A refusal means this client does not have authority to see figures;
 * the caller keeps the host and shows no bars.
 */

export interface HostResourceClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability?: string;
}

export type HostResourceRead =
  | { readonly status: "ready"; readonly snapshot: HostResourceSnapshot }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

export interface HostResourceClient {
  /** `signal` cancels the request; a cancelled read answers `unavailable`. */
  read(signal?: AbortSignal): Promise<HostResourceRead>;
}

export function createHostResourceClient(options: HostResourceClientOptions): HostResourceClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async read(signal) {
      const headers: Record<string, string> = {};
      if (options.windowCapability !== undefined && options.windowCapability.length > 0) {
        headers["x-octant-window-capability"] = options.windowCapability;
      }
      let response: Response;
      try {
        response = await fetch(new URL("/api/host/resources", options.baseUrl).toString(), {
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
        return { status: "ready", snapshot: decodeHostResourceSnapshot(await response.json()) };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
