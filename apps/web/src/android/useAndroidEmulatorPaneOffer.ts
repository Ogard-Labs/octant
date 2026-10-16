import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import type { AndroidSnapshotRequest } from "@octant/contracts/android-toolchain-rpc";
import type { AndroidRuntimeSnapshot } from "@octant/contracts/android-toolchain";
import { useEffect, useRef, useState } from "react";
import { scheduleVisibleInterval, waitUntilDocumentVisible } from "../polling/documentVisibility";

/** State and offer reads are not frames, so a few seconds of lag is invisible. */
const POLL_INTERVAL_MS = 3_000;

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
    if (!watch) {
      // A hidden window defers this one read until it is shown again.
      void waitUntilDocumentVisible(controller.signal).then(() => {
        if (!controller.signal.aborted) void pull();
      });
      return () => controller.abort();
    }
    // Visible-only: a hidden window does not poll, and showing it again pulls once.
    const stop = scheduleVisibleInterval(() => void pull(), POLL_INTERVAL_MS, {
      runImmediately: true,
    });
    return () => {
      controller.abort();
      stop();
    };
  }, [activityKey, client, enabled, requestKey, watch]);

  return held?.key === requestKey ? held.request : undefined;
}
