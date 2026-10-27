import type { AppleDeviceClient } from "@octant/client-runtime/apple-device-client";
import type {
  AppleDeviceDiscovery,
  AppleDeviceId,
  AppleDeviceRefusalReason,
  AppleDeviceRequest,
  AppleDeviceResponse,
} from "@octant/contracts/apple-toolchain";
import { useCallback, useEffect, useRef, useState } from "react";

/** A capture or a lease answers in seconds; a device that has not has not answered at all. */
const DEVICE_REQUEST_TIMEOUT_MS = 60_000;

export interface UseAppleDevicesOptions {
  readonly client: AppleDeviceClient;
  readonly scope: Pick<AppleDeviceRequest, "authority" | "threadId" | "checkoutId">;
  readonly createUuid: () => string;
  /**
   * The desktop app's lease confirmation for exactly this request. Absent
   * where the window cannot raise one; the pane then offers no lease.
   */
  readonly requestLease?: (request: AppleDeviceRequest) => Promise<string | undefined>;
  /** Remembers the person's Team ID per viewer, for this Project. */
  readonly teamKey: string;
}

export interface AppleDevicesController {
  readonly status: "loading" | "ready" | "failed";
  readonly discovery?: AppleDeviceDiscovery;
  readonly failure?: string;
  readonly selectedDeviceId?: string;
  readonly screenshotUrl?: string;
  readonly busy: boolean;
  readonly problem?: string;
  readonly team: string;
  readonly canConfirmLease: boolean;
  readonly select: (deviceId: AppleDeviceId) => void;
  readonly checkAgain: () => void;
  readonly leaseDevice: (deviceId: AppleDeviceId) => Promise<void>;
  readonly release: (deviceId: AppleDeviceId) => Promise<void>;
  readonly capture: (deviceId: AppleDeviceId) => Promise<void>;
  readonly setTeam: (team: string) => void;
}

/**
 * The Apple workbench's physical devices: one discovery when the pane opens
 * and whenever the person checks again or acts, never a poll, since each
 * look runs the selected Xcode's device tooling on the Mac.
 */
export function useAppleDevices(options: UseAppleDevicesOptions): AppleDevicesController {
  const { client, createUuid, requestLease, scope, teamKey } = options;
  const [status, setStatus] = useState<AppleDevicesController["status"]>("loading");
  const [discovery, setDiscovery] = useState<AppleDeviceDiscovery>();
  const [failure, setFailure] = useState<string>();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [team, setTeamState] = useState(() => readTeam(teamKey));
  const [latest, setLatest] = useState<ReadonlyMap<string, string>>(new Map());
  const [screenshot, setScreenshot] = useState<{
    readonly reference: string;
    readonly url: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKey = `${String(scope.threadId)}:${String(scope.checkoutId)}`;

  const request = useCallback(
    (
      kind: AppleDeviceRequest["kind"],
      extra: Partial<AppleDeviceRequest> = {},
    ): AppleDeviceRequest => ({
      actionId: createUuid() as never,
      correlationId: createUuid() as never,
      ...scopeRef.current,
      kind,
      requestedBy: localUserActor(),
      timeoutMs: DEVICE_REQUEST_TIMEOUT_MS,
      approval: { kind: "not-required" },
      ...extra,
    }),
    [createUuid],
  );

  const discover = useCallback(
    async (signal?: AbortSignal) => {
      const answer = await client.request(request("discover"), signal);
      if (signal?.aborted === true) return;
      if (answer.kind !== "apple-device-discovery") {
        setStatus("failed");
        setFailure(answerSentence(answer));
        return;
      }
      setDiscovery(answer.discovery);
      setFailure(undefined);
      setStatus("ready");
      setLatest(
        new Map(
          (answer.discovery.screenshots ?? []).map((shot) => [
            String(shot.deviceId),
            String(shot.reference),
          ]),
        ),
      );
      const devices = answer.discovery.devices;
      setSelectedDeviceId((current) => {
        if (
          current !== undefined &&
          devices.some((device) => String(device.deviceId) === current)
        ) {
          return current;
        }
        // The device this thread already uses comes first; otherwise the first one listed.
        const mine = answer.discovery.leases.find((lease) => lease.holder === "this-thread");
        return mine === undefined ? devices[0]?.deviceId : String(mine.deviceId);
      });
    },
    [client, request],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    void discover(controller.signal);
    return () => controller.abort();
  }, [attempt, discover, scopeKey]);

  // The latest screenshot of the chosen device, read as a blob this window
  // alone holds; the object URL is let go when it is replaced.
  const reference = selectedDeviceId === undefined ? undefined : latest.get(selectedDeviceId);
  useEffect(() => {
    if (reference === undefined) {
      setScreenshot(undefined);
      return;
    }
    const controller = new AbortController();
    let url: string | undefined;
    void client
      .readScreenshot(
        { kind: "apple-artifact-request", ...scopeRef.current, reference: reference as never },
        controller.signal,
      )
      .then((read) => {
        if (controller.signal.aborted || read.status !== "succeeded") return;
        url = URL.createObjectURL(read.blob);
        setScreenshot({ reference, url });
      });
    return () => {
      controller.abort();
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [client, reference]);

  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }, []);

  const leaseDevice = useCallback(
    async (deviceId: AppleDeviceId) =>
      await act(async () => {
        if (requestLease === undefined) {
          setProblem(
            "Letting this thread use a device is confirmed in Octant on the Mac it is paired with.",
          );
          return;
        }
        const base = request("use-device", { deviceId });
        // The desktop app names the device and the thread, and the host
        // starts the lease only on that answer.
        const approvalId = await requestLease(base);
        if (approvalId === undefined) {
          setProblem("The device was not given to this thread.");
          return;
        }
        const answer = await client.request({
          ...base,
          approval: { kind: "approved", approvalId: approvalId as never },
        });
        if (answer.kind !== "apple-device-leased") setProblem(answerSentence(answer));
        await discover();
      }),
    [act, client, discover, request, requestLease],
  );

  const release = useCallback(
    async (deviceId: AppleDeviceId) =>
      await act(async () => {
        const answer = await client.request(request("release-device", { deviceId }));
        if (answer.kind !== "apple-device-released") setProblem(answerSentence(answer));
        await discover();
      }),
    [act, client, discover, request],
  );

  const capture = useCallback(
    async (deviceId: AppleDeviceId) =>
      await act(async () => {
        const answer = await client.request(request("screenshot", { deviceId }));
        if (answer.kind !== "apple-device-evidence") {
          setProblem(answerSentence(answer));
          return;
        }
        const shot = answer.evidence.artifacts.find((artifact) => artifact.kind === "screenshot");
        if (answer.evidence.outcome !== "succeeded" || shot === undefined) {
          setProblem(
            "The screen could not be captured. Check that the device is unlocked, then try again.",
          );
          return;
        }
        setLatest((current) => new Map([...current, [String(deviceId), String(shot.reference)]]));
      }),
    [act, client, request],
  );

  const setTeam = useCallback(
    (next: string) => {
      setTeamState(next);
      writeTeam(teamKey, next);
    },
    [teamKey],
  );

  return {
    status,
    ...(discovery === undefined ? {} : { discovery }),
    ...(failure === undefined ? {} : { failure }),
    ...(selectedDeviceId === undefined ? {} : { selectedDeviceId }),
    ...(screenshot === undefined || screenshot.reference !== reference
      ? {}
      : { screenshotUrl: screenshot.url }),
    busy,
    ...(problem === undefined ? {} : { problem }),
    team,
    canConfirmLease: requestLease !== undefined,
    select: (deviceId) => setSelectedDeviceId(String(deviceId)),
    checkAgain: () => setAttempt((value) => value + 1),
    leaseDevice,
    release,
    capture,
    setTeam,
  };
}

/** What a device answer that did not do what was asked means to the person. */
function answerSentence(answer: AppleDeviceResponse): string {
  if (answer.kind === "apple-device-failure") return answer.failure.message;
  if (answer.kind === "apple-device-refused") return refusalSentence(answer.reason);
  return "The Mac answered something else than what was asked.";
}

function refusalSentence(reason: AppleDeviceRefusalReason): string {
  switch (reason) {
    case "toolchain-unavailable":
      return "Physical devices need Xcode selected on the Mac that runs this thread.";
    case "operation-unavailable":
      return "This Mac's Xcode does not offer that on a device.";
    case "destination-leased":
      return "Another thread is using this device.";
    case "lease-required":
      return "This thread is not using this device any more.";
    case "lease-changed":
      return "The device changed hands; check again.";
    case "confirmation-required":
    case "local-person-required":
      return "Letting this thread use a device is confirmed in Octant on the Mac it is paired with.";
    case "locked":
      return "The device is locked. Unlock it, then try again.";
    case "developer-mode-off":
      return "Developer Mode is off on the device.";
    case "untrusted":
      return "The device does not trust this Mac yet.";
    case "unavailable":
      return "The device can't be reached. Reconnect it, then check again.";
    case "invalid-destination":
      return "That device is no longer paired with this Mac; check again.";
    case "code-mode-required":
    case "core-capability-required":
    case "authority-mismatch":
    case "thread-mismatch":
    case "checkout-mismatch":
      return "This window can't act for this thread's checkout.";
    default:
      return "The Mac refused that device request.";
  }
}

function localUserActor(): AppleDeviceRequest["requestedBy"] {
  return { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000002" as never };
}

// The Team ID is a per-viewer convenience: storage may be absent or refuse
// (a private window), and the pane works without it.
function readTeam(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeTeam(key: string, team: string): void {
  try {
    globalThis.localStorage?.setItem(key, team);
  } catch {
    // Not remembered; the field still holds it for this view.
  }
}
