import type { MobileUsageWindowRow } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";

/** Past this, a weekday alone could be read as one already gone this week. */
const WEEKDAY_ONLY_MS = 6 * 24 * 60 * 60 * 1_000;

/**
 * When a window resets, in the phone's own locale: the time alone for a reset
 * later today, the weekday with it within the week, and the date beyond that,
 * so a weekly or monthly reset is not read as one this week. None for a time
 * that cannot be read.
 */
export function usageResetLabel(
  resetsAt: string,
  now: Date,
  locale?: string | undefined,
): string | undefined {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return undefined;
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return `Resets at ${time}`;
  if (at.getTime() - now.getTime() >= WEEKDAY_ONLY_MS) {
    const date = at.toLocaleDateString(locale, { month: "short", day: "numeric" });
    return `Resets ${date}, ${time}`;
  }
  const weekday = at.toLocaleDateString(locale, { weekday: "short" });
  return `Resets ${weekday} ${time}`;
}

/** The share used, spelled so the bar's colour is never the only signal. */
export function usageShareLabel(row: Pick<MobileUsageWindowRow, "usedPercent" | "level">): string {
  return row.level === "spent" ? MOBILE_COPY.usageLimitReached : `${row.usedPercent}% used`;
}
