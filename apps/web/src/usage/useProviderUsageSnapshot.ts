import type { ProviderUsageLimitsClient } from "@octant/client-runtime/provider-usage-limits-client";
import type { ProviderUsageLimitsSnapshot } from "@octant/contracts";
import { useEffect, useState } from "react";

/**
 * How often a surface asks again. The list is the host's last observation, not
 * a fresh provider call, so a few minutes keeps it current without spending
 * anything; a new reading arrives whenever a turn reports one.
 */
const REREAD_MS = 3 * 60_000;

/**
 * The host's last plan-limit observation for every provider, re-read every few
 * minutes, and the moment it was read (a window whose reset has passed drops
 * out against that time). An unreachable host leaves the last reading as it
 * was; the Usage page is where a failure is explained. Without a client there
 * is nothing to read.
 */
export function useProviderUsageSnapshot(client: ProviderUsageLimitsClient | undefined): {
  readonly snapshot: ProviderUsageLimitsSnapshot | undefined;
  readonly now: number;
} {
  const [snapshot, setSnapshot] = useState<ProviderUsageLimitsSnapshot>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (client === undefined) return;
    let cancelled = false;
    const read = () =>
      client.list().then(
        (next) => {
          if (cancelled) return;
          setSnapshot(next);
          setNow(Date.now());
        },
        () => undefined,
      );
    void read();
    const timer = setInterval(() => void read(), REREAD_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);
  return { snapshot, now };
}
