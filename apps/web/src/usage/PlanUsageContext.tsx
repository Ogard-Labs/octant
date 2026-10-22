import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { UsageBarStyle } from "@octant/contracts/shell";
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface PlanUsageValue {
  /** Absent where the window cannot ask the host for plan limits. */
  readonly client?: ProviderUsageLimitsClient;
  readonly barStyle: UsageBarStyle;
}

const PlanUsageContext = createContext<PlanUsageValue>({ barStyle: "smooth" });

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
}) {
  const { barStyle, client } = props;
  const value = useMemo<PlanUsageValue>(
    () => ({ barStyle, ...(client === undefined ? {} : { client }) }),
    [barStyle, client],
  );
  return <PlanUsageContext.Provider value={value}>{props.children}</PlanUsageContext.Provider>;
}

export function usePlanUsageClient(): ProviderUsageLimitsClient | undefined {
  return useContext(PlanUsageContext).client;
}

export function useUsageBarStyle(): UsageBarStyle {
  return useContext(PlanUsageContext).barStyle;
}
