import {
  decodeProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsSnapshot,
} from "@octant/contracts/provider-usage-limits";

export interface ProviderUsageLimitsClient {
  readonly list: () => Promise<ProviderUsageLimitsSnapshot>;
  readonly refresh: () => Promise<ProviderUsageLimitsSnapshot>;
}

export class ProviderUsageLimitsClientFailure extends Error {
  override readonly name = "ProviderUsageLimitsClientFailure";
}

export function createProviderUsageLimitsClient(options: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  readonly requestTimeoutMs?: number;
}): ProviderUsageLimitsClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    (base.hostname !== "127.0.0.1" && base.hostname !== "[::1]" && base.hostname !== "localhost")
  ) {
    throw new ProviderUsageLimitsClientFailure("Provider usage limits require loopback.");
  }
  const request = async (pathname: string, method: "GET" | "POST") => {
    let response: Response;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        options.fetch(new URL(pathname, base).toString(), {
          method,
          headers: { "x-octant-window-capability": options.windowCapability },
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new ProviderUsageLimitsClientFailure("Provider usage limits timed out."));
          }, options.requestTimeoutMs ?? 10_000);
        }),
      ]);
    } catch {
      throw new ProviderUsageLimitsClientFailure("Provider usage limits are unavailable.");
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    if (!response.ok)
      throw new ProviderUsageLimitsClientFailure("Provider usage limits request failed.");
    try {
      return decodeProviderUsageLimitsSnapshot(await response.json());
    } catch {
      throw new ProviderUsageLimitsClientFailure("Provider usage limits response is invalid.");
    }
  };
  return {
    list: () => request("/api/provider-usage-limits", "GET"),
    refresh: () => request("/api/provider-usage-limits/refresh", "POST"),
  };
}
