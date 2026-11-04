import {
  decodeProviderCloudRequest,
  decodeProviderCloudResponse,
  type ProviderCloudRequest,
  type ProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";

export interface ProviderCloudSessionClient {
  readonly execute: (
    command: ProviderCloudRequest,
    signal?: AbortSignal,
  ) => Promise<ProviderCloudResponse>;
}

export function createProviderCloudSessionClient(input: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}): ProviderCloudSessionClient {
  return {
    async execute(command, signal) {
      try {
        const response = await input.fetch(new URL("/api/provider-cloud", input.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": input.windowCapability,
          },
          body: JSON.stringify(decodeProviderCloudRequest(command)),
          ...(signal === undefined ? {} : { signal }),
        });
        if (!response.ok) return { status: "refused", reason: "unavailable" };
        return decodeProviderCloudResponse(await response.json());
      } catch {
        return { status: "refused", reason: "unavailable" };
      }
    },
  };
}
