import type { ProviderInstance } from "@octant/contracts";
import { useMemo } from "react";
import type { ComposerLimitWindow } from "../context/composerLimitWindows";
import { usePlanUsageInstances, usePlanUsageReading } from "./PlanUsageContext";
import { railUsageReadings, resetPhrase, type RailUsageReading } from "./railUsageReading";

/** One provider's plan reading, with the account it belongs to. */
export interface AccountUsageLine {
  readonly instance: ProviderInstance;
  readonly reading: RailUsageReading;
  /** The window with the least left, which is the one that stops work first. */
  readonly lowest: ComposerLimitWindow;
  /** "Resets in 2h 52m" for that window, when the provider said. */
  readonly reset?: string;
}

export interface AccountUsage {
  readonly lines: ReadonlyArray<AccountUsageLine>;
  /** The window with the least left across every provider: the account face's ring. */
  readonly lowest?: ComposerLimitWindow;
}

function lowestWindow(
  windows: ReadonlyArray<ComposerLimitWindow>,
): ComposerLimitWindow | undefined {
  return windows.reduce<ComposerLimitWindow | undefined>(
    (low, window) => (low === undefined || window.percent < low.percent ? window : low),
    undefined,
  );
}

/**
 * The plan readings of the accounts this window knows, read from the shared
 * usage reading so the account face, the composer and the Inbox ask the host
 * once. A provider that reports no window has no line.
 */
export function useAccountUsage(): AccountUsage {
  const { snapshot, now } = usePlanUsageReading();
  const instances = usePlanUsageInstances();
  return useMemo(() => {
    if (snapshot === undefined) return { lines: [] };
    const byId = new Map(instances.map((instance) => [String(instance.id), instance] as const));
    const lines = railUsageReadings(
      snapshot.entries.filter((entry) => byId.has(String(entry.providerInstanceId))),
      now,
    ).flatMap((reading): ReadonlyArray<AccountUsageLine> => {
      const instance = byId.get(reading.providerInstanceId);
      const lowest = lowestWindow(reading.windows);
      if (instance === undefined || lowest === undefined) return [];
      const reset = resetPhrase(reading.resetsAt.get(lowest.window), now);
      return [{ instance, reading, lowest, ...(reset === undefined ? {} : { reset }) }];
    });
    const lowest = lowestWindow(lines.map((line) => line.lowest));
    return lowest === undefined ? { lines } : { lines, lowest };
  }, [instances, now, snapshot]);
}
