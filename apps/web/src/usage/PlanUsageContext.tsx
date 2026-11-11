import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { ProviderInstance, ProviderUsageLimitsSnapshot } from "@octant/contracts";
import type { UsageBarStyle } from "@octant/contracts/shell";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useProviderUsageSnapshot } from "./useProviderUsageSnapshot";

export interface PlanUsageReading {
  readonly snapshot: ProviderUsageLimitsSnapshot | undefined;
  /** When the snapshot was read; a window whose reset has passed drops out against it. */
  readonly now: number;
}

interface PlanUsageValue {
  /** Absent where the window cannot ask the host for plan limits. */
  readonly client?: ProviderUsageLimitsClient;
  readonly barStyle: UsageBarStyle;
  /** The provider accounts the window knows, so a reading can be named. */
  readonly instances: ReadonlyArray<ProviderInstance>;
  /** The host's last plan-limit observation, read once for every consumer. */
  readonly reading: PlanUsageReading;
}

const NO_INSTANCES: ReadonlyArray<ProviderInstance> = [];
const NO_READING: PlanUsageReading = { snapshot: undefined, now: 0 };

const PlanUsageContext = createContext<PlanUsageValue>({
  barStyle: "smooth",
  instances: NO_INSTANCES,
  reading: NO_READING,
});

/**
 * What the plan-usage meters above every composer need from the shell: the
 * host's limits client, the Appearance choice of how the bar is drawn, and the
 * host's last plan-limit observation. Held once at the top so a composer on
 * the start screen, one in a thread, the rail and the Inbox read the same
 * snapshot, with one request and one timer.
 */
export function PlanUsageProvider(props: {
  readonly barStyle: UsageBarStyle;
  readonly children: ReactNode;
  readonly client?: ProviderUsageLimitsClient | undefined;
  readonly instances?: ReadonlyArray<ProviderInstance> | undefined;
}) {
  const { barStyle, client, instances = NO_INSTANCES } = props;
  const { snapshot, now } = useProviderUsageSnapshot(client);
  // The value stays the same object between readings, so a render of the app
  // above this provider commits nothing below it.
  const value = useMemo<PlanUsageValue>(
    () => ({
      barStyle,
      instances,
      reading: { snapshot, now },
      ...(client === undefined ? {} : { client }),
    }),
    [barStyle, client, instances, now, snapshot],
  );
  return <PlanUsageContext.Provider value={value}>{props.children}</PlanUsageContext.Provider>;
}

export function usePlanUsageClient(): ProviderUsageLimitsClient | undefined {
  return useContext(PlanUsageContext).client;
}

/** The shared plan-limit reading; empty where no provider holds one. */
export function usePlanUsageReading(): PlanUsageReading {
  return useContext(PlanUsageContext).reading;
}

export function usePlanUsageInstances(): ReadonlyArray<ProviderInstance> {
  return useContext(PlanUsageContext).instances;
}

export function useUsageBarStyle(): UsageBarStyle {
  return useContext(PlanUsageContext).barStyle;
}
