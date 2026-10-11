/**
 * Provider-neutral plan-usage facts for one account. Numbers come from that
 * provider's own process. Octant never reads, stores, or forwards a token to
 * fetch them, and never calls a vendor usage endpoint itself.
 *
 * Claude is the first adopter. Another CLI that reports the same windows can
 * reuse this shape without a second model.
 */

export const PROVIDER_PLAN_USAGE_WINDOW_IDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
] as const;

export type ProviderPlanUsageWindowId = (typeof PROVIDER_PLAN_USAGE_WINDOW_IDS)[number];

export type ProviderPlanUsageSource = "session-event" | "process-refresh";

export type ProviderPlanUsageWindowStatus = "allowed" | "warning" | "exhausted";

export interface ProviderPlanUsageOverage {
  readonly status: ProviderPlanUsageWindowStatus;
  readonly inUse?: boolean;
  readonly resetsAt?: string;
  readonly disabledReason?: string;
}

export interface ProviderPlanUsageWindow {
  readonly window: string;
  readonly status: ProviderPlanUsageWindowStatus;
  readonly utilization?: number;
  readonly resetsAt?: string;
  readonly observedAt: string;
  readonly overage?: ProviderPlanUsageOverage;
}

export interface ProviderAccountPlanUsageSnapshot {
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly available: boolean;
  readonly source: ProviderPlanUsageSource;
  readonly observedAt: string;
  readonly windows: ReadonlyArray<ProviderPlanUsageWindow>;
}

export function accountPlanUsageKey(input: {
  readonly instanceId: string;
  readonly stateDirectory: string;
}): string {
  const directory = stripTrailingSlashes(input.stateDirectory.trim());
  if (input.instanceId.trim().length === 0 || directory.length === 0) {
    throw new Error("Account plan-usage key needs the instance and its state directory.");
  }
  return `${input.instanceId}:${directory}`;
}

/** Process payloads report percent used (0–100). Store the share Octant already uses (0–1). */
export function planUsageUtilizationFromPercent(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value / 100, 1);
}

/** Session events already speak in 0–1 share. */
export function planUsageUtilizationFromShare(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, 1);
}

export function planUsageWindowStatus(
  utilization: number | undefined,
): ProviderPlanUsageWindowStatus {
  if (utilization === undefined) return "allowed";
  if (utilization >= 1) return "exhausted";
  if (utilization >= 0.8) return "warning";
  return "allowed";
}

export function planUsageStatusFromProcess(status: string): ProviderPlanUsageWindowStatus {
  if (status === "rejected") return "exhausted";
  if (status === "allowed_warning") return "warning";
  return "allowed";
}

export function perModelWeeklyWindowId(label: string): string {
  const trimmed = label.trim();
  return trimmed.length === 0 ? "per_model" : `per_model:${trimmed}`;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
