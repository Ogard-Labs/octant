import { ProviderUsageLimitsSnapshot } from "@octant/contracts/provider-usage-limits";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface AntigravityStatusLineStatus {
  readonly connected: boolean;
  readonly recordedAt?: string;
  readonly planTier?: string;
}

export interface AntigravityTerminalLaunchResult {
  readonly opened: boolean;
  readonly message?: string;
}

export interface ProviderUsageLimitsClient {
  readonly list: () => Promise<ProviderUsageLimitsSnapshot>;
  readonly refresh: () => Promise<ProviderUsageLimitsSnapshot>;
  readonly antigravityStatusLineStatus?: () => Promise<AntigravityStatusLineStatus>;
  readonly connectAntigravityStatusLine?: () => Promise<AntigravityStatusLineStatus>;
  readonly disconnectAntigravityStatusLine?: () => Promise<{
    readonly restored: boolean;
    readonly status: AntigravityStatusLineStatus;
  }>;
  readonly openAntigravityTerminal?: () => Promise<AntigravityTerminalLaunchResult>;
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
  const fetch = bindFetchPort(options.fetch);
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    (base.hostname !== "127.0.0.1" && base.hostname !== "[::1]" && base.hostname !== "localhost")
  ) {
    throw new ProviderUsageLimitsClientFailure("Provider usage limits require loopback.");
  }
  const requestJson = async (pathname: string, method: "GET" | "POST"): Promise<unknown> => {
    let response: Response;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        fetch(new URL(pathname, base).toString(), {
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
    if (!response.ok) {
      let message = "Provider usage limits request failed.";
      try {
        const body = (await response.json()) as { readonly message?: unknown };
        if (typeof body.message === "string" && body.message.trim().length > 0) {
          message = body.message;
        }
      } catch {}
      throw new ProviderUsageLimitsClientFailure(message);
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderUsageLimitsClientFailure("Provider usage limits response is invalid.");
    }
  };
  const request = async (pathname: string, method: "GET" | "POST") => {
    const body = await requestJson(pathname, method);
    try {
      return decodeHostAnswer(ProviderUsageLimitsSnapshot)(body);
    } catch {
      throw new ProviderUsageLimitsClientFailure("Provider usage limits response is invalid.");
    }
  };
  return {
    list: () => request("/api/provider-usage-limits", "GET"),
    refresh: () => request("/api/provider-usage-limits/refresh", "POST"),
    antigravityStatusLineStatus: () =>
      requestJson(
        "/api/provider-usage-limits/antigravity-statusline",
        "GET",
      ) as Promise<AntigravityStatusLineStatus>,
    connectAntigravityStatusLine: () =>
      requestJson(
        "/api/provider-usage-limits/antigravity-statusline/connect",
        "POST",
      ) as Promise<AntigravityStatusLineStatus>,
    disconnectAntigravityStatusLine: () =>
      requestJson(
        "/api/provider-usage-limits/antigravity-statusline/disconnect",
        "POST",
      ) as Promise<{
        readonly restored: boolean;
        readonly status: AntigravityStatusLineStatus;
      }>,
    openAntigravityTerminal: () =>
      requestJson(
        "/api/provider-usage-limits/antigravity-statusline/open-terminal",
        "POST",
      ) as Promise<AntigravityTerminalLaunchResult>,
  };
}
