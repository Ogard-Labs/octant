import { useMemo } from "react";
import { usePlanUsageReading } from "./PlanUsageContext";
import { providerRoomByInstance, type ProviderRoom } from "./providerRoom";

const NO_ROOMS: ReadonlyMap<string, ProviderRoom> = new Map();

/** How much room each provider account has, from the host's last plan-limit observation. */
export function useProviderRooms(): ReadonlyMap<string, ProviderRoom> {
  const { snapshot, now } = usePlanUsageReading();
  return useMemo(
    () => (snapshot === undefined ? NO_ROOMS : providerRoomByInstance(snapshot.entries, now)),
    [now, snapshot],
  );
}
