import {
  decodeProviderServiceLimits,
  type ProviderInstanceId,
  type ProviderRateLimitWindow,
  type ProviderServiceLimits,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  perModelWeeklyWindowId,
  planUsageUtilizationFromPercent,
  planUsageWindowStatus,
  type ProviderPlanUsageWindowStatus,
} from "@octant/domain";

const KNOWN_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;

/**
 * Thin adapter over the Claude process's experimental plan-usage answer.
 * The method name and payload can change without notice; Octant never
 * treats a miss as a reason to read credentials or call a vendor endpoint.
 */
export type ClaudeProcessPlanUsage =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly windows: ReadonlyArray<ProviderRateLimitWindow>;
    };

export function decodeClaudeProcessPlanUsage(
  value: unknown,
  observedAt: UtcTimestamp,
): ClaudeProcessPlanUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (payload.rate_limits_available === false) return { available: false };
  if (payload.rate_limits_available !== true) return undefined;
  const limits = payload.rate_limits;
  // Limits apply to this account, but the process holds no reading yet.
  // Observed with Claude Code 2.1.296: a process started only for this
  // question answers `rate_limits_available: true, rate_limits: null`,
  // because it learns its windows from the first model response. That is
  // "no answer", which keeps the last snapshot. Calling it "plan limits do
  // not apply" told a subscription account it has no plan.
  if (limits === null) return undefined;
  if (limits === undefined || typeof limits !== "object" || Array.isArray(limits)) {
    return undefined;
  }
  const record = limits as Record<string, unknown>;
  const windows: ProviderRateLimitWindow[] = [];
  for (const window of KNOWN_WINDOWS) {
    const decoded = decodeWindow(window, record[window], observedAt);
    if (decoded !== undefined) windows.push(decoded);
  }
  const scoped = record.model_scoped;
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const model = entry as Record<string, unknown>;
      const label = typeof model.display_name === "string" ? model.display_name : "";
      const decoded = decodeWindow(perModelWeeklyWindowId(label), model, observedAt);
      if (decoded !== undefined) windows.push(decoded);
    }
  }
  const extra = decodeOverageWindow(record.extra_usage, observedAt);
  if (extra !== undefined) windows.push(extra);
  if (windows.length > 32) return undefined;
  return { available: true, windows };
}

export function claudeProcessPlanUsageLimits(
  instanceId: ProviderInstanceId,
  usage: Extract<ClaudeProcessPlanUsage, { readonly available: true }>,
  observedAt: UtcTimestamp,
): ProviderServiceLimits {
  const exhausted = usage.windows.some((window) => window.status === "exhausted");
  return decodeProviderServiceLimits({
    providerInstanceId: instanceId,
    scope: "account",
    requests: { status: "unavailable" },
    tokens: { status: "unavailable" },
    concurrency: { status: "unavailable" },
    retry: { status: "inactive" },
    quota: exhausted ? "exhausted" : usage.windows.length === 0 ? "unknown" : "available",
    source: "runtime-reported",
    confidence: usage.windows.length === 0 ? "unknown" : "high",
    updatedAt: observedAt,
    ...(usage.windows.length === 0 ? {} : { rateLimitWindows: usage.windows }),
  });
}

function decodeWindow(
  window: string,
  value: unknown,
  observedAt: UtcTimestamp,
): ProviderRateLimitWindow | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const utilization = utilizationFromProcess(record.utilization);
  const resetsAt = timestampFromProcess(record.resets_at ?? record.resetsAt);
  return {
    window,
    status: planUsageWindowStatus(utilization),
    ...(utilization === undefined ? {} : { utilization }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    observedAt,
  };
}

function decodeOverageWindow(
  value: unknown,
  observedAt: UtcTimestamp,
): ProviderRateLimitWindow | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const utilization = utilizationFromProcess(record.utilization);
  const enabled = record.is_enabled === true;
  const status: ProviderPlanUsageWindowStatus =
    enabled && utilization !== undefined ? planUsageWindowStatus(utilization) : "allowed";
  return {
    window: "overage",
    status,
    ...(utilization === undefined ? {} : { utilization }),
    observedAt,
    overage: {
      status,
      inUse: enabled,
    },
  };
}

function utilizationFromProcess(value: unknown): number | undefined {
  return typeof value === "number" ? planUsageUtilizationFromPercent(value) : undefined;
}

function timestampFromProcess(value: unknown): UtcTimestamp | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString() as UtcTimestamp;
}
