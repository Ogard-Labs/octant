import { createRemoteProductFetch, type RemoteSessionBridge } from "@octant/client-runtime";
import { createHostControlClient } from "@octant/client-runtime/host-control-client";
import { useEffect, useMemo } from "react";
import type { ComposerStashScope } from "../composer/ComposerStashControls";

export function usePairedComposerStashScope(
  bridge: RemoteSessionBridge,
  host: string,
  canReadRetention: boolean,
  windowId?: string,
): ComposerStashScope {
  const reconcilePurges = useMemo(() => {
    if (!canReadRetention) return undefined;
    const client = createHostControlClient({
      // The authenticated session selects the host. This URL supplies the API path.
      baseUrl: "http://127.0.0.1",
      fetch: createRemoteProductFetch({ bridge }),
      windowCapability: "",
    });
    return async () => {
      if (globalThis.indexedDB === undefined) return;
      await import("../composer/composerStashStore")
        .then(({ reconcileComposerStashPurges }) =>
          reconcileComposerStashPurges(host, async () => {
            const state = bridge.getState();
            if (state.kind === "ready" && state.hostId === host) {
              return client.readThreadRetention();
            }
          }),
        )
        .catch(() => undefined);
    };
  }, [bridge, canReadRetention, host]);

  useEffect(() => {
    if (reconcilePurges === undefined) return;
    const refresh = () => void reconcilePurges();
    window.addEventListener("focus", refresh);
    refresh();
    return () => window.removeEventListener("focus", refresh);
  }, [reconcilePurges]);

  return { host, windowId, reconcilePurges };
}
