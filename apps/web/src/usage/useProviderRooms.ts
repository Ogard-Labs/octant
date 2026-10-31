import { useMemo } from "react";
import { usePlanUsageClient } from "./PlanUsageContext";
import { providerRoomByInstance, type ProviderRoom } from "./providerRoom";
import { useProviderUsageSnapshot } from "./useProviderUsageSnapshot";

const NO_ROOMS: ReadonlyMap<string, ProviderRoom> = new Map();

/** How much room each provider account has, from the host's last plan-limit observation. */
export function useProviderRooms(): ReadonlyMap<string, ProviderRoom> {
  const { snapshot, now } = useProviderUsageSnapshot(usePlanUsageClient());
  return useMemo(
    () => (snapshot === undefined ? NO_ROOMS : providerRoomByInstance(snapshot.entries, now)),
    [now, snapshot],
  );
}
