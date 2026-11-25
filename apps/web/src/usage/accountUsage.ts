import type { ProviderInstance } from "@octant/contracts";
import { useMemo } from "react";
import type { ComposerLimitWindow } from "../context/composerLimitWindows";
import { usePlanUsageInstances, usePlanUsageReading } from "./PlanUsageContext";
import { railUsageReadings, readingAgePhrase, resetPhrase, windowHours } from "./railUsageReading";

/** One plan window as the rail and the account menu say it. */
export interface AccountUsageWindow extends ComposerLimitWindow {
  /**
   * What a person can still use of it, in the start screen line's words: "60%
   * left", or "limit reached". A provider can call a window exhausted below
   * full use, and its unused share is then nothing left to spend.
   */
  readonly standing: string;
  /** "Resets in 2h 52m", when the provider said. */
  readonly reset: string | undefined;
}

/** One provider's plan reading, with the account it belongs to. */
export interface AccountUsageLine {
  readonly instance: ProviderInstance;
  /** "Last read 5h ago", for a reading made hours ago. */
  readonly age: string | undefined;
  /** Every reported window, shortest first, as the start screen's line lists them. */
  readonly windows: ReadonlyArray<AccountUsageWindow>;
  /** The window that stops work first: one at its limit, else the one with the least left. */
  readonly lowest: AccountUsageWindow;
}

/**
 * How many accounts the rail rings. Past this many the foot would push the
 * places out of a short window, so the rest wait in the account menu.
 */
export const RAIL_USAGE_LIMIT = 3;

/**
 * What stops work first: the windows at their limit, then the least left. A
 * provider can call every window exhausted when one ran out, so among spent
 * windows the fullest is the one that did.
 */
function byRoom(a: ComposerLimitWindow, b: ComposerLimitWindow): number {
  return Number(b.level === "spent") - Number(a.level === "spent") || a.percent - b.percent;
}

/**
 * The accounts the rail rings: those with the least left, kept in account order
 * so a ring never changes places as the figures move.
 */
export function railUsageLines(
  lines: ReadonlyArray<AccountUsageLine>,
): ReadonlyArray<AccountUsageLine> {
  const tightest = [...lines].sort((a, b) => byRoom(a.lowest, b.lowest)).slice(0, RAIL_USAGE_LIMIT);
  return lines.filter((line) => tightest.includes(line));
}

/**
 * The plan readings of the accounts this window knows, in the person's own
 * order (the host's snapshot sorts by id), read from the shared usage reading
 * so the rail, the account menu and the composer ask the host once. A provider
 * that reports no window has no line.
 */
export function useAccountUsage(): ReadonlyArray<AccountUsageLine> {
  const { snapshot, now } = usePlanUsageReading();
  const instances = usePlanUsageInstances();
  return useMemo(() => {
    const readings = railUsageReadings(snapshot?.entries ?? [], now);
    return instances.flatMap((instance): ReadonlyArray<AccountUsageLine> => {
      const reading = readings.find((entry) => entry.providerInstanceId === String(instance.id));
      const windows = (reading?.windows ?? [])
        .map((window) => ({
          ...window,
          standing: window.level === "spent" ? "limit reached" : `${String(window.percent)}% left`,
          reset: resetPhrase(reading?.resetsAt.get(window.window), now),
        }))
        .sort((a, b) => windowHours(a.window) - windowHours(b.window));
      const lowest = [...windows].sort(byRoom)[0];
      return reading === undefined || lowest === undefined
        ? []
        : [{ instance, age: readingAgePhrase(reading.observedAt, now), windows, lowest }];
    });
  }, [instances, now, snapshot]);
}
