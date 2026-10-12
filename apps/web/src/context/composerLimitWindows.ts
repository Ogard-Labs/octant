import type { ProviderRateLimitWindow } from "@octant/contracts/context";
import {
  providerLimitWindowName,
  providerLimitWindowShortLabel,
} from "../providers/providerLimitWindow";
import type { ComposerContextUsageFallback } from "./composerContextMeterScope";

/** The share used at which a limit bar takes the warning ink, as the meter's popover does. */
const NEAR_LIMIT_PERCENT = 80;

export interface ComposerLimitWindow {
  readonly window: string;
  /** Short enough for a narrow bar: "5h", "Week". */
  readonly short: string;
  /** The full name, with the provider's scope when it named one. */
  readonly name: string;
  /** How much of the window is left, in whole percent. The bar fills with this share. */
  readonly percent: number;
  readonly level: "ok" | "near" | "spent";
}

interface ReportedWindow {
  readonly window: string;
  readonly status: "allowed" | "warning" | "exhausted";
  readonly utilization?: number | undefined;
  readonly resetsAt?: string | undefined;
}

/**
 * The provider's account windows as the composer's stats line draws them. The
 * context snapshot's windows win; the Code thread's own report answers when the
 * snapshot has none. A window with no utilization draws no bar, because a bar
 * without a figure would invent one, and a window whose reset has passed draws
 * none either: its figure is from before the reset and no longer says how much
 * is used. Nothing reported means nothing drawn.
 */
export function composerLimitWindows(input: {
  readonly now: number;
  readonly snapshot?:
    | {
        readonly serviceLimits: {
          readonly rateLimitWindows?: ReadonlyArray<ProviderRateLimitWindow> | undefined;
        };
      }
    | undefined;
  readonly fallback?: ComposerContextUsageFallback | undefined;
}): ReadonlyArray<ComposerLimitWindow> {
  const fromSnapshot = input.snapshot?.serviceLimits.rateLimitWindows ?? [];
  const reported: ReadonlyArray<ReportedWindow> =
    fromSnapshot.length > 0 ? fromSnapshot : (input.fallback?.limits ?? []);
  const rows: ComposerLimitWindow[] = [];
  for (const limit of reported) {
    if (limit.utilization === undefined) continue;
    if (limit.resetsAt !== undefined && Date.parse(limit.resetsAt) <= input.now) continue;
    const used = Math.round(Math.max(0, Math.min(1, limit.utilization)) * 100);
    const scoped = providerLimitWindowName(limit.window);
    rows.push({
      window: limit.window,
      short: providerLimitWindowShortLabel(limit.window),
      name: scoped.scope === undefined ? scoped.label : `${scoped.label}, ${scoped.scope}`,
      percent: 100 - used,
      level:
        limit.status === "exhausted"
          ? "spent"
          : limit.status === "warning" || used >= NEAR_LIMIT_PERCENT
            ? "near"
            : "ok",
    });
  }
  return rows;
}
