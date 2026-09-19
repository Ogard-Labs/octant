import {
  AppleToolchainClientFailure,
  type AppleToolchainClient,
} from "@octant/client-runtime/apple-toolchain-client";
import type {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleRuntimeSnapshot,
} from "@octant/contracts/apple-toolchain";
import type {
  AppleCancelRequest,
  AppleDiscoverySnapshot,
  AppleSnapshotRequest,
} from "@octant/contracts/apple-toolchain-rpc";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppleWorkbenchStatus } from "./AppleWorkbenchPane";

export interface UseAppleWorkbenchOptions {
  readonly client: AppleToolchainClient;
  readonly discoveryRequest: AppleDiscoveryRequest;
  readonly snapshotRequest: AppleSnapshotRequest;
  readonly enabled?: boolean;
}

export interface AppleWorkbenchController {
  readonly status: AppleWorkbenchStatus;
  readonly discovery?: AppleDiscoverySnapshot;
  readonly runtime?: AppleRuntimeSnapshot;
  readonly errorMessage?: string;
  readonly retry: () => void;
  readonly execute: (request: AppleActionRequest) => Promise<AppleBuildEvidence>;
  readonly cancel: (request: AppleCancelRequest) => Promise<boolean>;
}

export function useAppleWorkbench(options: UseAppleWorkbenchOptions): AppleWorkbenchController {
  const { client, discoveryRequest, snapshotRequest, enabled = true } = options;
  const [status, setStatus] = useState<AppleWorkbenchStatus>("loading");
  const [discovery, setDiscovery] = useState<AppleDiscoverySnapshot>();
  const [runtime, setRuntime] = useState<AppleRuntimeSnapshot>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const discoveryRequestRef = useRef(discoveryRequest);
  const snapshotRequestRef = useRef(snapshotRequest);
  // Which discovery may still write the list. A background re-discovery that
  // answers after a newer action, or after the hook was pointed at another
  // project, must not put its older destinations back.
  const discoveryGeneration = useRef(0);
  discoveryRequestRef.current = discoveryRequest;
  snapshotRequestRef.current = snapshotRequest;
  const discoveryRequestKey = JSON.stringify(discoveryRequest);
  const snapshotRequestKey = JSON.stringify(snapshotRequest);

  const refreshSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      const next = await client.snapshot(snapshotRequestRef.current, signal);
      setRuntime(next);
      return next;
    },
    [client, snapshotRequestKey],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    discoveryGeneration.current += 1;
    setStatus("loading");
    setErrorMessage(undefined);
    void client
      .discover(discoveryRequestRef.current, controller.signal)
      .then(async (nextDiscovery) => {
        if (controller.signal.aborted) return;
        setDiscovery(nextDiscovery);
        await refreshSnapshot(controller.signal);
        if (controller.signal.aborted) return;
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          setStatus("interrupted");
          return;
        }
        const classified = classifyFailure(error);
        setStatus(classified.status);
        setErrorMessage(classified.message);
      });
    return () => controller.abort();
  }, [attempt, client, discoveryRequestKey, enabled, refreshSnapshot]);

  const execute = useCallback(
    async (request: AppleActionRequest) => {
      const evidence = await client.execute(request);
      const snapshot = await refreshSnapshot();
      // A boot or shutdown changes the destination list itself, and that list
      // lives in discovery, not the runtime snapshot. Without it a passed boot
      // still read "Shutdown" until the tool was re-opened. The snapshot just
      // read already carries the host's Simulator states, so the list takes
      // those at once; the full discovery — six probes, `xcodebuild -list`
      // among them — follows in the background instead of holding the action's
      // result and every control behind it, and a failure there changes nothing.
      if (request.kind === "boot" || request.kind === "shutdown") {
        setDiscovery((previous) =>
          previous === undefined ? previous : { ...previous, simulators: snapshot.simulators },
        );
        const generation = ++discoveryGeneration.current;
        void client
          .discover(discoveryRequestRef.current)
          .then((next) => {
            if (generation === discoveryGeneration.current) setDiscovery(next);
          })
          .catch(() => undefined);
      }
      setStatus("ready");
      return evidence;
    },
    [client, refreshSnapshot],
  );

  const cancel = useCallback(
    async (request: AppleCancelRequest) => {
      const cancelled = await client.cancel(request);
      await refreshSnapshot();
      return cancelled;
    },
    [client, refreshSnapshot],
  );

  return {
    status,
    ...(discovery === undefined ? {} : { discovery }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    retry,
    execute,
    cancel,
  };
}

function classifyFailure(error: unknown): {
  readonly status: Exclude<AppleWorkbenchStatus, "loading" | "waiting" | "ready">;
  readonly message: string;
} {
  if (error instanceof AppleToolchainClientFailure) {
    if (error.category === "interrupted") return { status: "interrupted", message: error.message };
    if (error.category === "unavailable" || error.category === "xcode-not-found") {
      return { status: "unavailable", message: error.message };
    }
    return { status: "failed", message: error.message };
  }
  return { status: "unavailable", message: "Apple toolchain service is unavailable." };
}
