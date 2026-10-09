import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import type {
  AndroidEmulatorId,
  AndroidEmulatorRecord,
  AndroidEmulatorRequest,
} from "@octant/contracts/android-toolchain";
import type {
  AndroidScreenFallbackReason,
  AndroidScreenTransport,
} from "@octant/contracts/android-toolchain-rpc";
import { LOCAL_TOOL_HOST_ID } from "@octant/contracts/tool-actions";
import {
  ANDROID_INPUT_GRANT_MS,
  androidInputGrantIsLive,
  decidesCodeEffectsByApproval,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
} from "@octant/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { CodeController } from "../code/useCodeController";
import type { DeviceInputIntent } from "../device/deviceInput";
import {
  deviceFailureDetail,
  deviceProblemFor,
  deviceWord,
  type DeviceAction,
  type DeviceActionFailure,
  type DeviceChoice,
  type DeviceDiagnostics,
  type DeviceView,
} from "../device/deviceModel";
import { DevicePane } from "../device/DevicePane";
import { useAndroidEmulator, type AndroidEmulatorController } from "./useAndroidEmulator";
import {
  useAndroidEmulatorLiveScreen,
  type AndroidEmulatorLiveScreen,
} from "./useAndroidEmulatorLiveScreen";

export type AndroidEmulatorIntent =
  | {
      readonly kind: "boot" | "shutdown" | "screenshot" | "open-input";
      readonly emulatorId: AndroidEmulatorId;
    }
  | {
      readonly kind: "tap";
      readonly emulatorId: AndroidEmulatorId;
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: "swipe";
      readonly emulatorId: AndroidEmulatorId;
      readonly point: { readonly x: number; readonly y: number };
      readonly toPoint: { readonly x: number; readonly y: number };
      readonly durationMs: number;
    }
  | { readonly kind: "type-text"; readonly emulatorId: AndroidEmulatorId; readonly text: string }
  | { readonly kind: "key-press"; readonly emulatorId: AndroidEmulatorId; readonly key: string };

export function AndroidEmulatorPane(props: {
  readonly client: AndroidToolchainClient;
  readonly createUuid: () => string;
  readonly hostBridge?: OctantHostBridge;
  readonly requestApproval?: (request: AndroidEmulatorRequest) => Promise<string | undefined>;
  readonly thread: NonNullable<CodeController["activeView"]>["thread"];
  readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
}) {
  const [identity] = useState(() => ({
    actionId: props.createUuid(),
    correlationId: props.createUuid(),
  }));
  const authority = useMemo(
    () => ({
      hostId: LOCAL_TOOL_HOST_ID,
      mode: "code" as const,
      projectId: props.thread.projectId,
      providerInstanceId: props.thread.providerInstanceId,
      extension: { kind: "core" as const },
    }),
    [props.thread.projectId, props.thread.providerInstanceId],
  );
  const discoveryRequest = useMemo(
    () => ({
      actionId: identity.actionId as never,
      correlationId: identity.correlationId as never,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
    }),
    [authority, identity.actionId, identity.correlationId, props.checkoutId, props.thread.id],
  );
  const snapshotRequest = useMemo(
    () => ({
      kind: "android-snapshot-request" as const,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
    }),
    [authority, props.checkoutId, props.thread.id],
  );
  const controller = useAndroidEmulator({
    client: props.client,
    discoveryRequest,
    snapshotRequest,
  });
  const [busy, setBusy] = useState(false);
  // A failure is kept with the emulator its request named, so one that
  // arrives after the pane moved to another emulator is never shown there.
  const [failed, setFailed] = useState<{
    readonly emulatorId: string;
    readonly failure: DeviceActionFailure<AndroidEmulatorIntent>;
  }>();
  // Which emulator the person chose to see. An agent's later request to show
  // a device replaces it, so the pane follows the newest ask.
  const [chosenEmulatorId, setChosenEmulatorId] = useState<AndroidEmulatorId>();
  const paneOpenRequestId = controller.runtime?.paneOpenRequest?.requestId;
  useEffect(() => setChosenEmulatorId(undefined), [paneOpenRequestId]);
  const [liveViewStopped, setLiveViewStopped] = useState(false);
  const [liveViewAttempt, setLiveViewAttempt] = useState(0);
  const approvalGated = decidesCodeEffectsByApproval(props.thread.executionPolicy);
  const rememberedInputGrants = useRef(new Map<string, number>());
  const inputFlight = useRef(Promise.resolve());
  // The epoch only wakes this surface after the host records a grant; the
  // per-Emulator expiry stays in rememberedInputGrants.
  const [, setRememberedGrantEpoch] = useState(0);
  const [frameAttach, setFrameAttach] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (!active) return;
      setFrameAttach(capabilities?.liveAndroidFrameSupported === true);
    });
    return () => {
      active = false;
    };
  }, [props.hostBridge]);

  const emulators = controller.discovery?.emulators ?? controller.runtime?.emulators ?? [];
  const preferred = chosenEmulatorId ?? controller.runtime?.paneOpenRequest?.emulatorId;
  // More than one emulator is running and nobody has said which to show: ask
  // rather than guess, since another task may own one of them, and
  // stream nothing from either meanwhile.
  // A choice holds while its emulator is booting or booted, so choosing one
  // that is still starting shows its boot rather than asking again.
  const chosenRunning = emulators.some(
    (emulator) =>
      chosenEmulatorId !== undefined &&
      String(emulator.emulatorId) === String(chosenEmulatorId) &&
      (emulator.state === "booted" || emulator.state === "booting"),
  );
  const awaitingChoice =
    !chosenRunning &&
    controller.runtime?.paneOpenRequest === undefined &&
    emulators.filter((emulator) => emulator.state === "booted").length > 1;
  const liveEmulator =
    emulators.find((emulator) => preferred !== undefined && emulator.emulatorId === preferred) ??
    emulators.find((emulator) => emulator.state === "booting") ??
    emulators.find((emulator) => emulator.state === "booted");
  const liveEmulatorId = liveEmulator?.state === "booted" ? liveEmulator.emulatorId : undefined;
  // A failure belongs to the emulator it happened on; showing another drops it,
  // so the line and its Try again never name one device and act on another.
  const shownEmulator = liveEmulatorId === undefined ? undefined : String(liveEmulatorId);
  useEffect(() => setFailed(undefined), [shownEmulator]);
  const actionFailure =
    failed !== undefined && failed.emulatorId === shownEmulator ? failed.failure : undefined;
  const rememberedUntil =
    liveEmulatorId === undefined
      ? 0
      : (rememberedInputGrants.current.get(String(liveEmulatorId)) ?? 0);
  const inputAllowed =
    !approvalGated ||
    (liveEmulatorId !== undefined &&
      (androidInputGrantIsLive(controller.runtime, String(liveEmulatorId), Date.now()) ||
        rememberedUntil > Date.now()));
  const needsAllowInput = approvalGated && !inputAllowed;
  const screenStreamRequest = useMemo(
    () =>
      liveEmulatorId === undefined
        ? undefined
        : {
            kind: "android-screen-stream-request" as const,
            authority,
            threadId: props.thread.id,
            checkoutId: props.checkoutId,
            emulatorId: liveEmulatorId,
          },
    [authority, liveEmulatorId, props.checkoutId, props.thread.id],
  );
  const liveScreen = useAndroidEmulatorLiveScreen({
    client: props.client,
    enabled: liveEmulatorId !== undefined && !liveViewStopped && !awaitingChoice,
    attempt: liveViewAttempt,
    ...(screenStreamRequest === undefined ? {} : { request: screenStreamRequest }),
  });

  const run = useCallback(
    async (intent: AndroidEmulatorIntent) => {
      const previous = inputFlight.current;
      let release = () => {};
      inputFlight.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const emulatorId = String(intent.emulatorId);
      const setActionFailure = (failure: DeviceActionFailure<AndroidEmulatorIntent>) =>
        setFailed({ emulatorId, failure });
      setFailed(undefined);
      setBusy(true);
      try {
        const base = androidActionRequest({
          intent,
          actionId: props.createUuid(),
          correlationId: props.createUuid(),
          authority,
          threadId: props.thread.id,
          checkoutId: props.checkoutId,
        });
        let request = base;
        const now = Date.now();
        const remembered = rememberedInputGrants.current.get(emulatorId) ?? 0;
        const grantLive =
          androidInputGrantIsLive(controller.runtime, emulatorId, now) || remembered > now;
        if (approvalGated && isAndroidEmulatorInputKind(intent.kind) && !grantLive) {
          setActionFailure({ kind: "input-not-allowed" });
          return;
        }
        if (approvalGated && isAndroidEmulatorOpenInputKind(intent.kind) && grantLive) {
          return;
        }
        if (
          approvalGated &&
          intent.kind !== "screenshot" &&
          !(isAndroidEmulatorInputKind(intent.kind) && grantLive)
        ) {
          if (props.requestApproval === undefined) {
            setActionFailure({ kind: "cannot-confirm" });
            return;
          }
          const approvalId = await props.requestApproval(base);
          if (approvalId === undefined) {
            setActionFailure({ kind: "not-approved", intent });
            return;
          }
          request = { ...base, approval: { kind: "approved", approvalId: approvalId as never } };
          if (isAndroidEmulatorOpenInputKind(intent.kind)) {
            rememberedInputGrants.current.set(emulatorId, Date.now() + ANDROID_INPUT_GRANT_MS);
            setRememberedGrantEpoch(Date.now());
          }
        }
        const evidence = await controller.execute(request);
        if (evidence.outcome === "succeeded" && isAndroidEmulatorOpenInputKind(intent.kind)) {
          rememberedInputGrants.current.set(emulatorId, Date.now() + ANDROID_INPUT_GRANT_MS);
          setRememberedGrantEpoch(Date.now());
        }
        if (evidence.outcome === "succeeded" && intent.kind === "shutdown") {
          rememberedInputGrants.current.delete(emulatorId);
          setRememberedGrantEpoch(Date.now());
        }
        if (evidence.outcome !== "succeeded") {
          setActionFailure({ kind: "outcome", intent, outcome: evidence.outcome });
        }
      } catch {
        setActionFailure({ kind: "no-answer", intent });
      } finally {
        setBusy(false);
        release();
      }
    },
    [
      approvalGated,
      authority,
      controller,
      props.checkoutId,
      props.createUuid,
      props.requestApproval,
      props.thread.id,
    ],
  );

  const offerInput =
    frameAttach &&
    inputAllowed &&
    liveEmulatorId !== undefined &&
    (props.requestApproval !== undefined || !approvalGated);
  const devices = emulators.map(emulatorChoice);
  const view = awaitingChoice
    ? ({ kind: "pick" } as const)
    : androidDeviceView({ controller, devices, liveEmulator, liveScreen, liveViewStopped });
  const live = liveEmulatorId === undefined ? undefined : liveEmulator;

  const onAction = (action: DeviceAction) => {
    switch (action.kind) {
      case "allow-input":
        if (liveEmulatorId !== undefined)
          void run({ kind: "open-input", emulatorId: liveEmulatorId });
        return;
      case "screenshot":
        if (liveEmulatorId !== undefined)
          void run({ kind: "screenshot", emulatorId: liveEmulatorId });
        return;
      case "shutdown":
        if (liveEmulatorId !== undefined)
          void run({ kind: "shutdown", emulatorId: liveEmulatorId });
        return;
      case "boot":
      case "select": {
        const emulator = emulators.find((one) => String(one.emulatorId) === action.deviceId);
        if (emulator === undefined) return;
        setChosenEmulatorId(emulator.emulatorId);
        if (emulator.state === "shutdown")
          void run({ kind: "boot", emulatorId: emulator.emulatorId });
        return;
      }
      case "check-again":
        controller.retry();
        return;
      case "stop-live-view":
        setLiveViewStopped(true);
        return;
      case "reconnect":
        setLiveViewStopped(false);
        setLiveViewAttempt((attempt) => attempt + 1);
        return;
    }
  };
  const problem =
    actionFailure === undefined
      ? undefined
      : deviceProblemFor(actionFailure, {
          platform: "android",
          deviceName: live?.name ?? "the emulator",
          retry: (intent: AndroidEmulatorIntent) => void run(intent),
          ...(liveEmulatorId === undefined
            ? {}
            : {
                allowInput: () => void run({ kind: "open-input", emulatorId: liveEmulatorId }),
              }),
        });

  return (
    <DevicePane
      busy={busy}
      devices={devices}
      diagnostics={androidDiagnostics({
        controller,
        liveScreen,
        liveViewStopped,
        actionFailure,
      })}
      inputAllowed={offerInput}
      needsApproval={needsAllowInput && frameAttach && liveEmulatorId !== undefined}
      onAction={onAction}
      {...(liveEmulatorId === undefined || !frameAttach
        ? {}
        : {
            onInput: (intent: DeviceInputIntent) =>
              void run(androidInputIntent(liveEmulatorId, intent)),
          })}
      platform="android"
      {...(problem === undefined ? {} : { problem })}
      view={view}
    />
  );
}

function androidDeviceView(input: {
  readonly controller: AndroidEmulatorController;
  readonly devices: ReadonlyArray<DeviceChoice>;
  readonly liveEmulator: AndroidEmulatorRecord | undefined;
  readonly liveScreen: AndroidEmulatorLiveScreen;
  readonly liveViewStopped: boolean;
}): DeviceView {
  const { controller, devices, liveEmulator, liveScreen } = input;
  if (controller.status === "loading" || controller.status === "waiting") {
    return { kind: "checking" };
  }
  if (controller.status !== "ready") {
    const missing = controller.status === "unavailable";
    return {
      kind: "setup",
      title: "Set up the Android emulator",
      checks: [
        missing
          ? {
              id: "sdk",
              label: "Android SDK",
              state: "missing",
              detail: "The SDK wasn't found on this host.",
              fix: "Install platform-tools and the emulator with the Android SDK Manager.",
            }
          : { id: "sdk", label: "Android SDK", state: "waiting", detail: "Not checked yet" },
        { id: "avd", label: "Virtual device", state: "waiting", detail: "Checked after the SDK" },
      ],
      ...(controller.errorMessage === undefined || missing
        ? {}
        : { note: controller.errorMessage }),
    };
  }
  if (devices.length === 0) {
    return {
      kind: "setup",
      title: "Set up the Android emulator",
      checks: [
        { id: "sdk", label: "Android SDK", state: "ok" },
        {
          id: "avd",
          label: "Virtual device",
          state: "missing",
          detail: "No Android Virtual Device was found.",
          fix: "Create one in Android Studio › Device Manager.",
        },
      ],
    };
  }
  const device =
    liveEmulator === undefined
      ? undefined
      : devices.find((one) => one.id === String(liveEmulator.emulatorId));
  if (device?.state === "booting") return { kind: "booting", device };
  if (device?.state === "booted") {
    if (input.liveViewStopped) {
      return { kind: "live", device, screen: { kind: "none" }, liveView: "stopped" };
    }
    if (liveScreen.status === "live") {
      return {
        kind: "live",
        device,
        screen: { kind: "stream", size: liveScreen.screen, attach: liveScreen.attach },
        liveView: "streaming",
        ...(liveScreen.transport === undefined
          ? {}
          : { transport: transportLabel(liveScreen.transport) }),
      };
    }
    if (liveScreen.status === "connecting") {
      return { kind: "live", device, screen: { kind: "connecting" }, liveView: "connecting" };
    }
    return {
      kind: "live",
      device,
      screen: { kind: "none" },
      liveView: liveScreen.status === "unavailable" ? "lost" : "not-offered",
    };
  }
  const stopping = devices.find((one) => one.state === "shutting-down");
  return stopping === undefined ? { kind: "pick" } : { kind: "shutting-down", device: stopping };
}

function androidDiagnostics(input: {
  readonly controller: AndroidEmulatorController;
  readonly liveScreen: AndroidEmulatorLiveScreen;
  readonly liveViewStopped: boolean;
  readonly actionFailure: DeviceActionFailure<AndroidEmulatorIntent> | undefined;
}): DeviceDiagnostics {
  const status = input.liveScreen.status;
  return {
    facts: [
      {
        label: "Live view",
        value: input.liveViewStopped
          ? "Off"
          : status === "live"
            ? "Streaming"
            : status === "connecting"
              ? "Connecting"
              : "Not attached",
      },
      ...(input.actionFailure === undefined
        ? []
        : [{ label: "Last problem", value: deviceFailureDetail(input.actionFailure) }]),
    ],
    running: (input.controller.runtime?.active ?? [])
      .filter((progress) => progress.state !== "completed")
      .map((progress) => ({
        id: String(progress.actionId),
        label: deviceWord(progress.kind),
        step: deviceWord(progress.step),
      })),
    recent: [...(input.controller.runtime?.recentEvidence ?? [])]
      .slice(-5)
      .reverse()
      .map((item) => {
        const first = item.diagnostics[0];
        return {
          id: `${String(item.actionId)}:${item.completedAt}`,
          label: deviceWord(item.kind),
          outcome: deviceWord(item.outcome),
          ...(first === undefined ? {} : { detail: first.message }),
        };
      }),
  };
}

function emulatorChoice(emulator: AndroidEmulatorRecord): DeviceChoice {
  return {
    id: String(emulator.emulatorId),
    name: emulator.name,
    ...(emulator.apiLevel === undefined ? {} : { os: `API ${emulator.apiLevel}` }),
    state: emulator.state,
  };
}

function androidInputIntent(
  emulatorId: AndroidEmulatorId,
  intent: DeviceInputIntent,
): AndroidEmulatorIntent {
  switch (intent.kind) {
    case "tap":
      return { kind: "tap", emulatorId, point: intent.point };
    case "swipe":
      return {
        kind: "swipe",
        emulatorId,
        point: intent.from,
        toPoint: intent.to,
        durationMs: intent.durationMs,
      };
    case "type-text":
      return { kind: "type-text", emulatorId, text: intent.text };
    case "key-press":
      return { kind: "key-press", emulatorId, key: intent.key };
  }
}

function androidActionRequest(input: {
  readonly intent: AndroidEmulatorIntent;
  readonly actionId: string;
  readonly correlationId: string;
  readonly authority: AndroidEmulatorRequest["authority"];
  readonly threadId: AndroidEmulatorRequest["threadId"];
  readonly checkoutId: AndroidEmulatorRequest["checkoutId"];
}): AndroidEmulatorRequest {
  const intent = input.intent;
  const base = {
    actionId: input.actionId as never,
    correlationId: input.correlationId as never,
    authority: input.authority,
    threadId: input.threadId,
    checkoutId: input.checkoutId,
    emulatorId: intent.emulatorId,
    approval: { kind: "not-required" as const },
  };
  switch (intent.kind) {
    case "boot":
      return { ...base, kind: "boot", timeoutMs: 180_000 };
    case "shutdown":
      return { ...base, kind: "shutdown", timeoutMs: 30_000 };
    case "screenshot":
      return { ...base, kind: "screenshot", timeoutMs: 30_000 };
    case "open-input":
      return {
        ...base,
        kind: "open-input",
        requestedBy: localUserActor(),
        timeoutMs: 30_000,
      };
    case "tap":
      return {
        ...base,
        kind: "tap",
        requestedBy: localUserActor(),
        point: intent.point,
        timeoutMs: 30_000,
      };
    case "swipe":
      return {
        ...base,
        kind: "swipe",
        requestedBy: localUserActor(),
        point: intent.point,
        toPoint: intent.toPoint,
        durationMs: intent.durationMs,
        timeoutMs: 30_000,
      };
    case "type-text":
      return {
        ...base,
        kind: "type-text",
        requestedBy: localUserActor(),
        text: intent.text,
        timeoutMs: 30_000,
      };
    case "key-press":
      return {
        ...base,
        kind: "key-press",
        requestedBy: localUserActor(),
        key: intent.key,
        timeoutMs: 30_000,
      };
  }
}

function localUserActor(): { readonly kind: "local-user"; readonly actorId: never } {
  return {
    kind: "local-user",
    actorId: "00000000-0000-4000-8000-000000000002" as never,
  };
}

/** Says whether the pane shows serve-avd's stream or adb screencap snapshots, and why. */
function transportLabel(transport: AndroidScreenTransport): string {
  if (transport.kind === "stream") return "Live stream";
  const reasons: Record<AndroidScreenFallbackReason, string> = {
    "no-desktop": "this host is not running in the Octant desktop app.",
    "not-emulator": "only emulators stream.",
    "tool-missing": "serve-avd is not installed.",
    "tool-exited": "serve-avd stopped before it attached.",
    "timed-out": "serve-avd did not attach in time.",
    "desktop-unreachable": "the desktop app did not answer.",
    "no-frames": "the stream sent no picture.",
  };
  return `Snapshots, live stream unavailable: ${reasons[transport.reason]}`;
}
