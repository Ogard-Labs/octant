import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { orderProviderInstances } from "@octant/domain";
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
  /** The provider accounts the window knows, in the person's order, so a reading can be named. */
  readonly instances: ReadonlyArray<ProviderInstance>;
  /** The host's last plan-limit observation, read once for every consumer. */
  readonly reading: PlanUsageReading;
}

const NO_INSTANCES: ReadonlyArray<ProviderInstance> = [];
const NO_READING: PlanUsageReading = { snapshot: undefined, now: 0 };

const PlanUsageContext = createContext<PlanUsageValue>({
  instances: NO_INSTANCES,
  reading: NO_READING,
});

/**
 * What plan usage needs from the shell: the host's limits client and the
 * host's last plan-limit observation. Held once at the top so the start
 * screen's line and the rail's account menu and ring read the same snapshot,
 * with one request and one timer.
 */
export function PlanUsageProvider(props: {
  readonly children: ReactNode;
  readonly client?: ProviderUsageLimitsClient | undefined;
  readonly instances?: ReadonlyArray<ProviderInstance> | undefined;
  /** The person's provider order: a reorder changes it without reading the accounts again. */
  readonly order?: ReadonlyArray<ProviderInstanceId> | undefined;
}) {
  const { client, instances = NO_INSTANCES, order } = props;
  const { snapshot, now } = useProviderUsageSnapshot(client);
  // The value stays the same object between readings, so a render of the app
  // above this provider commits nothing below it.
  const value = useMemo<PlanUsageValue>(
    () => ({
      instances: order === undefined ? instances : orderProviderInstances(instances, order),
      reading: { snapshot, now },
      ...(client === undefined ? {} : { client }),
    }),
    [client, instances, now, order, snapshot],
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
