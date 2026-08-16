import type { HostClient } from "@octant/client-runtime/host-client";
import type { HostIdentity } from "@octant/contracts/host";
import { useEffect, useState } from "react";

const HOST_STARTUP_RETRY_MS = 500;
const HOST_STARTUP_MAX_RETRY_MS = 8_000;
const HOST_STARTUP_MAX_ATTEMPTS = 6;

export function useHostObservation(client: HostClient): ReadonlyArray<HostIdentity> {
  const [hosts, setHosts] = useState<ReadonlyArray<HostIdentity>>([]);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    async function observe(): Promise<void> {
      attempts += 1;
      try {
        const next = await client.list();
        if (active) setHosts(next);
      } catch {
        if (!active) return;
        setHosts([]);
        if (attempts >= HOST_STARTUP_MAX_ATTEMPTS) return;
        const delay = Math.min(
          HOST_STARTUP_RETRY_MS * 2 ** (attempts - 1),
          HOST_STARTUP_MAX_RETRY_MS,
        );
        retryTimer = setTimeout(() => void observe(), delay);
      }
    }

    void observe();
    return () => {
      active = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [client]);

  return hosts;
}
