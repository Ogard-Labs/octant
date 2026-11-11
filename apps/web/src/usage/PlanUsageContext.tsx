import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { ProviderInstance } from "@octant/contracts";
import type { UsageBarStyle } from "@octant/contracts/shell";
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PlanUsageValue {
  /** Absent where the window cannot ask the host for plan limits. */
  readonly client?: ProviderUsageLimitsClient;
  readonly barStyle: UsageBarStyle;
  /** The provider accounts the window knows, so a reading can be named. */
  readonly instances: ReadonlyArray<ProviderInstance>;
}

const NO_INSTANCES: ReadonlyArray<ProviderInstance> = [];

const PlanUsageContext = createContext<PlanUsageValue>({
  barStyle: "smooth",
  instances: NO_INSTANCES,
});

/**
 * What the plan-usage meters above every composer need from the shell: the
 * host's limits client, and the Appearance choice of how the bar is drawn.
 * Held once at the top so a composer on the start screen and one in a thread
 * read the same.
 */
export function PlanUsageProvider(props: {
  readonly barStyle: UsageBarStyle;
  readonly children: ReactNode;
  readonly client?: ProviderUsageLimitsClient | undefined;
  readonly instances?: ReadonlyArray<ProviderInstance> | undefined;
}) {
  const { barStyle, client, instances = NO_INSTANCES } = props;
  const value = useMemo<PlanUsageValue>(
    () => ({ barStyle, instances, ...(client === undefined ? {} : { client }) }),
    [barStyle, client, instances],
  );
  return <PlanUsageContext.Provider value={value}>{props.children}</PlanUsageContext.Provider>;
}

export function usePlanUsageClient(): ProviderUsageLimitsClient | undefined {
  return useContext(PlanUsageContext).client;
}

export function usePlanUsageInstances(): ReadonlyArray<ProviderInstance> {
  return useContext(PlanUsageContext).instances;
}

export function useUsageBarStyle(): UsageBarStyle {
  return useContext(PlanUsageContext).barStyle;
}
