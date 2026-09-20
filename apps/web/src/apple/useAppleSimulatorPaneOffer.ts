import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleRuntimeSnapshot } from "@octant/contracts/apple-toolchain";
import type { AppleSnapshotRequest } from "@octant/contracts/apple-toolchain-rpc";
import { useEffect, useRef, useState } from "react";

type PaneOpenRequest = AppleRuntimeSnapshot["paneOpenRequest"];

/**
 * The in-app pane request currently on the Apple runtime snapshot, when an
 * agent has asked this thread to show a Simulator. Polls while an
 * `octant_apple` tool is running, and once whenever that activity changes,
 * so a fast `open` is not missed and a long `boot` still raises the pane
 * before it finishes.
 */
export function useAppleSimulatorPaneOffer(options: {
  readonly client?: AppleToolchainClient;
  readonly snapshotRequest?: AppleSnapshotRequest;
  readonly enabled: boolean;
  readonly watch: boolean;
  readonly activityKey: string;
}): PaneOpenRequest {
  const { client, enabled, snapshotRequest, watch, activityKey } = options;
  const snapshotRequestRef = useRef(snapshotRequest);
  snapshotRequestRef.current = snapshotRequest;
  const requestKey = snapshotRequest === undefined ? "" : JSON.stringify(snapshotRequest);
  // The held request is only for this snapshot scope. Returning a previous
  // thread's request while App keys the dock by the active thread would open
  // B's iOS Simulator tab for A's destination.
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
