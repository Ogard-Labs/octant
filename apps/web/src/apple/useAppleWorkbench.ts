import {
  AppleToolchainClientFailure,
  type AppleToolchainClient,
} from "@octant/client-runtime/apple-toolchain-client";
import type {
  AppleActionRequest,
  AppleBuildEvidence,
  AppleDiscoveryRequest,
  AppleDiscoveryStep,
  AppleRuntimeSnapshot,
} from "@octant/contracts/apple-toolchain";
import type {
  AppleCancelRequest,
  AppleDiscoverySnapshot,
  AppleSnapshotRequest,
} from "@octant/contracts/apple-toolchain-rpc";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppleWorkbenchStatus } from "./AppleWorkbenchPane";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

/** State and offer reads are not frames, so a few seconds of lag is invisible. */
const POLL_INTERVAL_MS = 3_000;
/** How often an open, visible pane asks whether a Simulator was added or removed. */
const DESTINATIONS_POLL_INTERVAL_MS = 15_000;

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
  /** The client failure's category, so Xcode missing can read as a setup step. */
  readonly errorCategory?: string;
  /** The discovery probe the host reported failing, so the checklist can name the step. */
  readonly errorStep?: AppleDiscoveryStep;
  readonly retry: () => void;
  /** Reads the host's runtime snapshot again, for a view that follows it while it is open. */
  readonly refresh: (signal?: AbortSignal) => Promise<AppleRuntimeSnapshot>;
  readonly execute: (request: AppleActionRequest) => Promise<AppleBuildEvidence>;
  readonly cancel: (request: AppleCancelRequest) => Promise<boolean>;
}

export function useAppleWorkbench(options: UseAppleWorkbenchOptions): AppleWorkbenchController {
  const { client, discoveryRequest, snapshotRequest, enabled = true } = options;
  const [status, setStatus] = useState<AppleWorkbenchStatus>("loading");
  const [discovery, setDiscovery] = useState<AppleDiscoverySnapshot>();
  const [runtime, setRuntime] = useState<AppleRuntimeSnapshot>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [errorCategory, setErrorCategory] = useState<string>();
  const [errorStep, setErrorStep] = useState<AppleDiscoveryStep>();
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
    setErrorCategory(undefined);
    setErrorStep(undefined);
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
        if (error instanceof AppleToolchainClientFailure) {
          setErrorCategory(error.category);
          setErrorStep(error.step);
        }
      });
    return () => controller.abort();
  }, [attempt, client, discoveryRequestKey, enabled, refreshSnapshot]);

  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const watching = (runtime?.active.length ?? 0) > 0 || runtime?.paneOpenRequest !== undefined;
    const controller = new AbortController();
    const pull = async () => {
      try {
        const next = await refreshSnapshot(controller.signal);
        if (controller.signal.aborted) return;
        setDiscovery((previous) =>
          previous === undefined
            ? previous
            : {
                ...previous,
                // The host re-reads the device list on its own cadence, so an
                // open pane also learns of a Simulator made elsewhere.
                simulators: withNewSimulators(
                  withNewerStates(previous.simulators, next.simulators, undefined),
                  next.simulators,
                ),
              },
        );
      } catch {
        // A poll that fails leaves the last good snapshot; the next one tries again.
      }
    };
    // Visible-only: a hidden window does not poll, and showing it again pulls once.
    // While a tool runs the state is followed closely; otherwise only the
    // destination list is checked, slowly.
    const stop = scheduleVisibleInterval(
      () => void pull(),
      watching ? POLL_INTERVAL_MS : DESTINATIONS_POLL_INTERVAL_MS,
      { runImmediately: watching },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [
    enabled,
    refreshSnapshot,
    runtime?.active.length,
    runtime?.paneOpenRequest?.requestId,
    status,
  ]);

  const execute = useCallback(
    async (request: AppleActionRequest) => {
      const changesDestinations = request.kind === "boot" || request.kind === "shutdown";
      // Taken before the first wait: two overlapping actions can finish out of
      // order, and only the one started last may write the destination list.
      const generation = changesDestinations
        ? ++discoveryGeneration.current
        : discoveryGeneration.current;
      const evidence = await client.execute(request);
      const snapshot = await refreshSnapshot();
      // A boot or shutdown changes the destination list itself, and that list
      // lives in discovery, not the runtime snapshot. Without it a passed boot
      // still read "Shutdown" until the tool was re-opened. The snapshot just
      // read already carries the host's Simulator states, so the list takes
      // those at once; the full discovery — six probes, `xcodebuild -list`
      // among them — follows in the background instead of holding the action's
      // result and every control behind it, and a failure there changes nothing.
      if (changesDestinations && generation === discoveryGeneration.current) {
        const acted =
          evidence.outcome === "succeeded" && request.simulatorId !== undefined
            ? {
                simulatorId: String(request.simulatorId),
                state: request.kind === "boot" ? ("booted" as const) : ("shutdown" as const),
              }
            : undefined;
        setDiscovery((previous) =>
          previous === undefined
            ? previous
            : {
                ...previous,
                simulators: withNewerStates(previous.simulators, snapshot.simulators, acted),
              },
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
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(errorStep === undefined ? {} : { errorStep }),
    retry,
    refresh: refreshSnapshot,
    execute,
    cancel,
  };
}

type SimulatorRecords = AppleDiscoverySnapshot["simulators"];

/** Simulators the host now lists that the pane's list lacks, after the ones it has. */
function withNewSimulators(listed: SimulatorRecords, reported: SimulatorRecords): SimulatorRecords {
  const known = new Set(listed.map((record) => String(record.simulatorId)));
  const added = reported.filter((record) => !known.has(String(record.simulatorId)));
  return added.length === 0 ? listed : [...listed, ...added];
}

/**
 * The listed destinations with the states the host now reports. States are
 * merged into the records already shown rather than the list being replaced:
 * a discovery that failed its first probe empties the host's runtime list, and
 * replacing with that removed every destination until a later discovery
 * succeeded. The action's own passed result is used only for a Simulator the
 * host's list no longer names; where the host names it, the host's state is
 * the newer one — someone else may have acted since the action passed.
 */
function withNewerStates(
  listed: SimulatorRecords,
  reported: SimulatorRecords,
  acted: { readonly simulatorId: string; readonly state: "booted" | "shutdown" } | undefined,
): SimulatorRecords {
  const states = new Map(reported.map((record) => [String(record.simulatorId), record.state]));
  if (acted !== undefined && !states.has(acted.simulatorId)) {
    states.set(acted.simulatorId, acted.state);
  }
  return listed.map((record) => {
    const state = states.get(String(record.simulatorId));
    return state === undefined || state === record.state ? record : { ...record, state };
  });
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
