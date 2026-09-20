import {
  AndroidToolchainClientFailure,
  type AndroidToolchainClient,
} from "@octant/client-runtime/android-toolchain-client";
import type {
  AndroidDiscoveryRequest,
  AndroidEmulatorEvidence,
  AndroidEmulatorRequest,
  AndroidRuntimeSnapshot,
} from "@octant/contracts/android-toolchain";
import type {
  AndroidCancelRequest,
  AndroidDiscoverySnapshot,
  AndroidSnapshotRequest,
} from "@octant/contracts/android-toolchain-rpc";
import { useCallback, useEffect, useRef, useState } from "react";

export type AndroidEmulatorStatus =
  | "loading"
  | "waiting"
  | "unavailable"
  | "interrupted"
  | "failed"
  | "ready";

export interface UseAndroidEmulatorOptions {
  readonly client: AndroidToolchainClient;
  readonly discoveryRequest: AndroidDiscoveryRequest;
  readonly snapshotRequest: AndroidSnapshotRequest;
  readonly enabled?: boolean;
}

export interface AndroidEmulatorController {
  readonly status: AndroidEmulatorStatus;
  readonly discovery?: AndroidDiscoverySnapshot;
  readonly runtime?: AndroidRuntimeSnapshot;
  readonly errorMessage?: string;
  readonly retry: () => void;
  readonly execute: (request: AndroidEmulatorRequest) => Promise<AndroidEmulatorEvidence>;
  readonly cancel: (request: AndroidCancelRequest) => Promise<boolean>;
}

export function useAndroidEmulator(options: UseAndroidEmulatorOptions): AndroidEmulatorController {
  const { client, discoveryRequest, snapshotRequest, enabled = true } = options;
  const [status, setStatus] = useState<AndroidEmulatorStatus>("loading");
  const [discovery, setDiscovery] = useState<AndroidDiscoverySnapshot>();
  const [runtime, setRuntime] = useState<AndroidRuntimeSnapshot>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const discoveryRequestRef = useRef(discoveryRequest);
  const snapshotRequestRef = useRef(snapshotRequest);
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
        if (error instanceof AndroidToolchainClientFailure && error.category === "sdk-not-found") {
          setStatus("unavailable");
          setErrorMessage(error.message);
          return;
        }
        setStatus("failed");
        setErrorMessage(
          error instanceof Error ? error.message : "The Android toolchain service did not answer.",
        );
      });
    return () => controller.abort();
  }, [attempt, client, discoveryRequestKey, enabled, refreshSnapshot]);

  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const watching = (runtime?.active.length ?? 0) > 0 || runtime?.paneOpenRequest !== undefined;
    if (!watching) return;
    const controller = new AbortController();
    const pull = async () => {
      try {
        const next = await refreshSnapshot(controller.signal);
        if (controller.signal.aborted) return;
        setDiscovery((previous) =>
          previous === undefined
            ? previous
            : { ...previous, emulators: next.emulators },
        );
      } catch {
        // A poll that fails leaves the last good snapshot.
      }
    };
    void pull();
    const interval = setInterval(() => void pull(), 1_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [enabled, refreshSnapshot, runtime?.active.length, runtime?.paneOpenRequest?.requestId, status]);

  const execute = useCallback(
    async (request: AndroidEmulatorRequest) => {
      const changesDestinations = request.kind === "boot" || request.kind === "shutdown";
      const generation = changesDestinations
        ? ++discoveryGeneration.current
        : discoveryGeneration.current;
      const evidence = await client.execute(request);
      const snapshot = await refreshSnapshot();
      if (changesDestinations && generation === discoveryGeneration.current) {
        setDiscovery((previous) =>
          previous === undefined ? previous : { ...previous, emulators: snapshot.emulators },
        );
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
    async (request: AndroidCancelRequest) => {
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
