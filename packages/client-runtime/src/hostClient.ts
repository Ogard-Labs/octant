import { decodeHostListResponse, type HostIdentity } from "@octant/contracts/host";
import { bindFetchPort } from "./bindFetchPort";

export interface HostClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

export interface HostClient {
  list(): Promise<ReadonlyArray<HostIdentity>>;
}

export class HostClientFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostClientFailure";
  }
}

export function createHostClient(options: HostClientOptions): HostClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async list() {
      const response = await fetch(new URL("/api/hosts", options.baseUrl).toString(), {
        method: "GET",
      });
      if (!response.ok) {
        throw new HostClientFailure(`Host observation failed with status ${response.status}.`);
      }
      try {
        return decodeHostListResponse(await response.json()).hosts;
      } catch (cause) {
        throw new HostClientFailure("Host observation returned an invalid response.", { cause });
      }
    },
  };
}
