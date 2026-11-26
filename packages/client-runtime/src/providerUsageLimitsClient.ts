import { ProviderUsageLimitsSnapshot } from "@octant/contracts/provider-usage-limits";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ProviderLimitsCaptureStatus {
  readonly connected: boolean;
  readonly recordedAt?: string;
  readonly planTier?: string;
  readonly summary: string;
  readonly disconnectedHint: string;
  readonly connectedHint: string;
  readonly connectLabel: string;
  readonly refreshActionLabel?: string;
}

export interface ProviderLimitsCaptureRefreshResult {
  readonly launched: boolean;
  readonly message?: string;
}

export interface ProviderUsageLimitsClient {
  readonly list: () => Promise<ProviderUsageLimitsSnapshot>;
  readonly refresh: () => Promise<ProviderUsageLimitsSnapshot>;
  readonly listLimitsCaptures?: () => Promise<
    Readonly<Record<string, ProviderLimitsCaptureStatus>>
  >;
  readonly connectLimitsCapture?: (instanceId: string) => Promise<ProviderLimitsCaptureStatus>;
  readonly disconnectLimitsCapture?: (instanceId: string) => Promise<{
    readonly restored: boolean;
    readonly status: ProviderLimitsCaptureStatus;
  }>;
  readonly triggerLimitsCaptureRefresh?: (
    instanceId: string,
  ) => Promise<ProviderLimitsCaptureRefreshResult>;
}

export class ProviderUsageLimitsClientFailure extends Error {
  override readonly name = "ProviderUsageLimitsClientFailure";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCaptureStatus(value: unknown): ProviderLimitsCaptureStatus {
  if (
    !isRecord(value) ||
    typeof value.connected !== "boolean" ||
    typeof value.summary !== "string" ||
    typeof value.disconnectedHint !== "string" ||
    typeof value.connectedHint !== "string" ||
    typeof value.connectLabel !== "string" ||
    (value.recordedAt !== undefined && typeof value.recordedAt !== "string") ||
    (value.planTier !== undefined && typeof value.planTier !== "string") ||
    (value.refreshActionLabel !== undefined && typeof value.refreshActionLabel !== "string")
  ) {
    throw new ProviderUsageLimitsClientFailure("Provider limits capture response is invalid.");
  }
  return {
    connected: value.connected,
    ...(value.recordedAt === undefined ? {} : { recordedAt: value.recordedAt }),
    ...(value.planTier === undefined ? {} : { planTier: value.planTier }),
    summary: value.summary,
    disconnectedHint: value.disconnectedHint,
    connectedHint: value.connectedHint,
    connectLabel: value.connectLabel,
    ...(value.refreshActionLabel === undefined
      ? {}
      : { refreshActionLabel: value.refreshActionLabel }),
  };
}

function decodeCaptureMap(value: unknown): Readonly<Record<string, ProviderLimitsCaptureStatus>> {
  if (!isRecord(value) || !isRecord(value.captures)) {
    throw new ProviderUsageLimitsClientFailure("Provider limits capture list response is invalid.");
  }
  const result: Record<string, ProviderLimitsCaptureStatus> = {};
  for (const [instanceId, status] of Object.entries(value.captures)) {
    result[instanceId] = decodeCaptureStatus(status);
  }
  return result;
}

function decodeDisconnectResult(value: unknown): {
  readonly restored: boolean;
  readonly status: ProviderLimitsCaptureStatus;
} {
  if (!isRecord(value) || typeof value.restored !== "boolean") {
    throw new ProviderUsageLimitsClientFailure(
      "Provider limits capture disconnect response is invalid.",
    );
  }
  return {
    restored: value.restored,
    status: decodeCaptureStatus(value.status),
  };
}

function decodeRefreshResult(value: unknown): ProviderLimitsCaptureRefreshResult {
  if (
    !isRecord(value) ||
    typeof value.launched !== "boolean" ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    throw new ProviderUsageLimitsClientFailure(
      "Provider limits capture refresh response is invalid.",
    );
  }
  return {
    launched: value.launched,
    ...(value.message === undefined ? {} : { message: value.message }),
  };
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
    listLimitsCaptures: async () =>
      decodeCaptureMap(await requestJson("/api/provider-usage-limits/capture", "GET")),
    connectLimitsCapture: async (instanceId) =>
      decodeCaptureStatus(
        await requestJson(
          `/api/provider-usage-limits/capture/${encodeURIComponent(instanceId)}/connect`,
          "POST",
        ),
      ),
    disconnectLimitsCapture: async (instanceId) =>
      decodeDisconnectResult(
        await requestJson(
          `/api/provider-usage-limits/capture/${encodeURIComponent(instanceId)}/disconnect`,
          "POST",
        ),
      ),
    triggerLimitsCaptureRefresh: async (instanceId) =>
      decodeRefreshResult(
        await requestJson(
          `/api/provider-usage-limits/capture/${encodeURIComponent(instanceId)}/trigger-refresh`,
          "POST",
        ),
      ),
  };
}
