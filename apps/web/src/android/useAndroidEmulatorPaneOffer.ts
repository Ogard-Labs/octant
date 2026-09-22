import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import type { AndroidSnapshotRequest } from "@octant/contracts/android-toolchain-rpc";
import type { AndroidRuntimeSnapshot } from "@octant/contracts/android-toolchain";
import { useEffect, useRef, useState } from "react";

type PaneOpenRequest = AndroidRuntimeSnapshot["paneOpenRequest"];

export function useAndroidEmulatorPaneOffer(options: {
  readonly client?: AndroidToolchainClient;
  readonly snapshotRequest?: AndroidSnapshotRequest;
  readonly enabled: boolean;
  readonly watch: boolean;
  readonly activityKey: string;
}): PaneOpenRequest {
  const { client, enabled, snapshotRequest, watch, activityKey } = options;
  const snapshotRequestRef = useRef(snapshotRequest);
  snapshotRequestRef.current = snapshotRequest;
  const requestKey = snapshotRequest === undefined ? "" : JSON.stringify(snapshotRequest);
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly request: PaneOpenRequest;
  }>();

  useEffect(() => {
    if (!enabled || client === undefined || snapshotRequestRef.current === undefined) {
      setHeld(undefined);
      return;
    }
    if (!watch && activityKey.length === 0) return;
    const controller = new AbortController();
    const pull = async () => {
      const current = snapshotRequestRef.current;
      if (current === undefined) return;
      try {
        const snapshot = await client.snapshot(current, controller.signal);
        if (!controller.signal.aborted) {
          setHeld({ key: requestKey, request: snapshot.paneOpenRequest });
        }
      } catch {
        if (!controller.signal.aborted) setHeld({ key: requestKey, request: undefined });
      }
    };
    void pull();
    if (!watch) return () => controller.abort();
    const interval = setInterval(() => void pull(), 750);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [activityKey, client, enabled, requestKey, watch]);

  return held?.key === requestKey ? held.request : undefined;
}
