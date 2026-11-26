import {
  ProviderUsageLimitsSnapshot,
  decodeHostAnswer,
  type ProviderRateLimitWindow,
  type ProviderUsageLimitsUnavailableReason,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { providerLimitWindowName } from "./providerLimitWindow";

/**
 * What the computer said when the phone asked for plan usage. A refusal is its
 * own answer: the computer chose not to share usage with this phone, which is
 * not the same as being out of reach.
 */
export type MobileUsageLimitsRead =
  | { readonly status: "read"; readonly snapshot: ProviderUsageLimitsSnapshot }
  | { readonly status: "refused" }
  | { readonly status: "unavailable"; readonly message: string };

/** Reads the computer's plan usage; `refresh` asks it to look again first. */
export async function readMobileProviderUsageLimits(
  transport: MobileRemoteTransport,
  options: { readonly refresh: boolean },
): Promise<MobileUsageLimitsRead> {
  let response: Response;
  try {
    response = await transport.authenticatedFetch(
      options.refresh
        ? { method: "POST", path: "/api/provider-usage-limits/refresh" }
        : { method: "GET", path: "/api/provider-usage-limits" },
    );
  } catch {
    return { status: "unavailable", message: "The computer could not be reached." };
  }
  if (response.status === 403) return { status: "refused" };
  if (!response.ok) {
    return { status: "unavailable", message: "The computer could not report plan usage." };
  }
  try {
    const snapshot = decodeHostAnswer(ProviderUsageLimitsSnapshot)(await response.json());
    return { status: "read", snapshot };
  } catch {
    return {
      status: "unavailable",
      message:
        "The computer sent plan usage this app version cannot read. Update the app or the computer.",
    };
  }
}

/** The share used at which a window reads as nearly spent, as the desktop's meter draws it. */
const NEAR_USED_PERCENT = 80;

export type MobileUsageLevel = "ok" | "near" | "spent";

export interface MobileUsageWindowRow {
  readonly window: string;
  readonly name: string;
  readonly usedPercent: number;
  readonly level: MobileUsageLevel;
  readonly resetsAt?: string;
  /** From the last successful read, shown because the latest one failed. */
  readonly old?: true;
}

export type MobileUsageAccount = { readonly providerInstanceId: string } & (
  | { readonly state: "windows"; readonly rows: ReadonlyArray<MobileUsageWindowRow> }
  | { readonly state: "unavailable"; readonly reason: string }
  | {
      readonly state: "failed";
      readonly message: string;
      readonly retryAt?: string;
      readonly staleRows: ReadonlyArray<MobileUsageWindowRow>;
    }
);

const NO_FIGURES = "No usage figures are reported right now.";

const UNAVAILABLE_REASONS: Readonly<Record<ProviderUsageLimitsUnavailableReason, string>> = {
  unsupported: "This account can report plan usage, but this version does not read it yet.",
  "not-configured": "This account is not set up yet, so its usage is not known.",
  "not-ready": "This account is not ready, so its usage is not known.",
  "runtime-does-not-report": "This provider does not report plan usage.",
  "local-runtime": "This model runs on the computer, so there is no plan to measure.",
  "endpoint-silent": "This endpoint did not report any usage limits.",
  "plan-limits-do-not-apply": "Plan limits do not apply to this account.",
};

/**
 * The windows a person can read a figure from. A window with no utilization
 * has no figure to draw, unless it is spent: that is still a limit the account
 * has reached, as the desktop says. One whose reset has passed carries a figure
 * from before the reset that no longer says how much is used.
 */
function usageRows(
  windows: ReadonlyArray<ProviderRateLimitWindow> | undefined,
  now: number,
  old: boolean,
): ReadonlyArray<MobileUsageWindowRow> {
  const rows: MobileUsageWindowRow[] = [];
  for (const limit of windows ?? []) {
    if (limit.utilization === undefined && limit.status !== "exhausted") continue;
    if (limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= now) continue;
    const usedPercent =
      limit.utilization === undefined
        ? 100
        : Math.round(Math.max(0, Math.min(1, limit.utilization)) * 100);
    const { label, scope } = providerLimitWindowName(limit.window);
    rows.push({
      window: limit.window,
      name: scope === undefined ? label : `${label}, ${scope}`,
      usedPercent,
      level:
        limit.status === "exhausted"
          ? "spent"
          : limit.status === "warning" || usedPercent >= NEAR_USED_PERCENT
            ? "near"
            : "ok",
      ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
      ...(old ? { old: true as const } : {}),
    });
  }
  return rows;
}

/** Each provider account's plan usage as the phone's Usage screen draws it. */
export function mobileUsageAccounts(
  snapshot: ProviderUsageLimitsSnapshot,
  now: number,
): ReadonlyArray<MobileUsageAccount> {
  return snapshot.entries.map((entry): MobileUsageAccount => {
    const providerInstanceId = String(entry.providerInstanceId);
    if (entry.status === "unavailable") {
      return {
        providerInstanceId,
        state: "unavailable",
        reason: UNAVAILABLE_REASONS[entry.reason],
      };
    }
    if (entry.status === "failed") {
      return {
        providerInstanceId,
        state: "failed",
        message: entry.failure.message,
        ...(entry.failure.retryAt === undefined ? {} : { retryAt: entry.failure.retryAt }),
        staleRows: usageRows(entry.staleLimits?.rateLimitWindows, now, true),
      };
    }
    const rows = usageRows(entry.limits.rateLimitWindows, now, false);
    return rows.length === 0
      ? { providerInstanceId, state: "unavailable", reason: NO_FIGURES }
      : { providerInstanceId, state: "windows", rows };
  });
}
