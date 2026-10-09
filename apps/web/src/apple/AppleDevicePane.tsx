import type { AppleSimulatorRecord } from "@octant/contracts/apple-toolchain";
import type { DeviceInputIntent } from "../device/deviceInput";
import {
  deviceFailureDetail,
  deviceProblemFor,
  deviceWord,
  type DeviceAction,
  type DeviceChoice,
  type DeviceDiagnostics,
  type DeviceScreenSource,
  type DeviceSetupCheck,
  type DeviceView,
} from "../device/deviceModel";
import { DevicePane } from "../device/DevicePane";
import type { AppleWorkbenchIntent, AppleWorkbenchPaneProps } from "./AppleWorkbenchPane";

/**
 * The dock's iOS Simulator tab. It translates what the Apple workbench knows
 * into the device pane's picture and turns the pane's requests back into
 * workbench intents. Approval, grants, and running stay with `onRun`.
 */
export function AppleDevicePane(props: AppleWorkbenchPaneProps) {
  const simulators = props.discovery?.simulators ?? props.runtime?.simulators ?? [];
  const devices = simulators.map(simulatorChoice);
  const view = appleDeviceView(props, devices);
  const live = props.liveFrame?.status === "live" ? props.liveFrame : undefined;
  const { onRun } = props;
  const simulatorFor = (id: string) =>
    simulators.find((simulator) => String(simulator.simulatorId) === id);

  const onAction =
    onRun === undefined
      ? undefined
      : (action: DeviceAction) => {
          switch (action.kind) {
            case "allow-input":
              if (live !== undefined) onRun({ kind: "open-input", simulatorId: live.simulatorId });
              return;
            case "screenshot":
              if (live !== undefined) onRun({ kind: "screenshot", simulatorId: live.simulatorId });
              return;
            case "shutdown":
              if (live !== undefined) onRun({ kind: "shutdown", simulatorId: live.simulatorId });
              return;
            case "boot":
            case "select": {
              const simulator = simulatorFor(action.deviceId);
              if (simulator === undefined) return;
              props.onSelectSimulator?.(simulator.simulatorId);
              if (simulator.state === "shutdown") {
                onRun({ kind: "boot", simulatorId: simulator.simulatorId });
              }
              return;
            }
            case "check-again":
              props.onRetry?.();
              return;
            case "stop-live-view":
              props.onLiveView?.("stop");
              return;
            case "reconnect": {
              const frame = props.liveFrame;
              // After a restart the pane is live again once a fresh screen is
              // seen; a capture is what proves that.
              if (frame?.status === "stale-after-restart" && frame.simulatorId !== undefined) {
                onRun({ kind: "screenshot", simulatorId: frame.simulatorId });
              } else if (frame?.status === "live") {
                props.onLiveView?.("reconnect");
              } else {
                props.onRetry?.();
              }
              return;
            }
          }
        };

  const onInput =
    onRun === undefined || live === undefined
      ? undefined
      : (intent: DeviceInputIntent) => onRun(appleInputIntent(live.simulatorId, intent));

  const deviceName = live?.name ?? "the Simulator";
  const problem =
    props.actionFailure === undefined
      ? undefined
      : deviceProblemFor(props.actionFailure, {
          platform: "ios",
          deviceName,
          ...(onRun === undefined
            ? {}
            : { retry: (intent: AppleWorkbenchIntent) => onRun(intent) }),
          ...(onRun !== undefined && live !== undefined
            ? {
                allowInput: () => onRun({ kind: "open-input", simulatorId: live.simulatorId }),
              }
            : {}),
          ...(onRun === undefined
            ? {}
            : {
                // Repairs the Simulator the refused request named, which the
                // host reported as disconnected.
                repairInput: (intent: AppleWorkbenchIntent) => {
                  if ("simulatorId" in intent) {
                    onRun({ kind: "repair-input", simulatorId: intent.simulatorId });
                  }
                },
              }),
        });

  return (
    <DevicePane
      busy={props.busy === true}
      devices={devices}
      diagnostics={appleDiagnostics(props)}
      inputAllowed={props.inputAllowed !== false}
      needsApproval={props.needsAllowInput === true}
      {...(onAction === undefined ? {} : { onAction })}
      {...(onInput === undefined ? {} : { onInput })}
      platform="ios"
      {...(problem === undefined ? {} : { problem })}
      view={view}
    />
  );
}

function appleDeviceView(
  props: AppleWorkbenchPaneProps,
  devices: ReadonlyArray<DeviceChoice>,
): DeviceView {
  const frame = props.liveFrame;
  if (props.status === "loading" || props.status === "waiting") return { kind: "checking" };
  if (props.status === "unavailable" || props.status === "failed") return appleSetup(props);
  if (props.status === "interrupted" || frame?.status === "interrupted") {
    return { kind: "last-screen", reason: "interrupted" };
  }
  if (frame === undefined || frame.status === "setup") return { kind: "checking" };
  if (props.awaitingChoice === true && (frame.status === "live" || frame.status === "booting")) {
    return { kind: "pick" };
  }
  const choice = (id: string | undefined) =>
    id === undefined ? undefined : devices.find((device) => device.id === id);
  switch (frame.status) {
    case "booting": {
      const device = choice(String(frame.simulatorId));
      return device === undefined ? { kind: "checking" } : { kind: "booting", device };
    }
    case "live": {
      const device = choice(String(frame.simulatorId)) ?? {
        id: String(frame.simulatorId),
        name: frame.name,
        state: "booted",
      };
      return { kind: "live", device, ...liveScreenOf(props) };
    }
    case "stale-after-restart": {
      const device = choice(
        frame.simulatorId === undefined ? undefined : String(frame.simulatorId),
      );
      return {
        kind: "last-screen",
        reason: "restart",
        ...(device === undefined ? {} : { device }),
      };
    }
    case "unavailable":
      switch (frame.reason) {
        case "toolchain-missing":
          return appleSetup(props);
        case "thread-mismatch":
          return {
            kind: "unavailable",
            message: "This Simulator belongs to another Code thread.",
          };
        case "not-attachable":
          return {
            kind: "unavailable",
            message: "This window can't show the live Simulator; open the thread on its Mac.",
          };
        case "no-destination": {
          if (devices.length === 0) return appleSetup(props);
          const stopping = devices.find((device) => device.state === "shutting-down");
          return stopping === undefined
            ? { kind: "pick" }
            : { kind: "shutting-down", device: stopping };
        }
      }
  }
}

function liveScreenOf(props: AppleWorkbenchPaneProps): {
  readonly screen: DeviceScreenSource;
  readonly liveView: LiveViewState;
} {
  const still: DeviceScreenSource =
    props.screenUrl === undefined ? { kind: "none" } : { kind: "still", url: props.screenUrl };
  if (props.liveViewStopped === true) return { screen: still, liveView: "stopped" };
  const stream = props.liveScreen;
  if (stream?.status === "live") {
    return {
      screen: { kind: "stream", size: stream.screen, attach: stream.attach },
      liveView: "streaming",
    };
  }
  if (stream?.status === "connecting") {
    return {
      screen: still.kind === "still" ? still : { kind: "connecting" },
      liveView: "connecting",
    };
  }
  if (stream?.status === "unavailable") return { screen: still, liveView: "lost" };
  return { screen: still, liveView: "not-offered" };
}

type LiveViewState = Extract<DeviceView, { kind: "live" }>["liveView"];

/**
 * Three rows from what discovery already reports: Xcode, a Simulator runtime,
 * and the project. Discovery cannot yet tell a missing licence apart from
 * other failures, so there is no licence row.
 */
function appleSetup(props: AppleWorkbenchPaneProps): DeviceView {
  const discovery = props.discovery;
  const xcodeMissing =
    props.errorCategory === "xcode-not-found" ||
    discovery?.toolchain.available === false ||
    (props.liveFrame?.status === "unavailable" && props.liveFrame.reason === "toolchain-missing");
  const xcodeOk = !xcodeMissing && discovery?.toolchain.available === true;
  const simulators = discovery?.simulators ?? [];
  const runtime = simulators[0];
  const checks: DeviceSetupCheck[] = [
    xcodeOk
      ? {
          id: "xcode",
          label: "Xcode selected",
          state: "ok",
          ...(discovery.toolchain.xcodeVersion === undefined
            ? {}
            : { detail: `Xcode ${discovery.toolchain.xcodeVersion}` }),
        }
      : xcodeMissing
        ? {
            id: "xcode",
            label: "Xcode selected",
            state: "missing",
            detail: "Xcode wasn't found on this Mac.",
            fix: "Install Xcode, then select it with xcode-select.",
          }
        : { id: "xcode", label: "Xcode selected", state: "waiting", detail: "Not checked yet" },
    xcodeOk && runtime !== undefined
      ? {
          id: "runtime",
          label: "iOS Simulator runtime",
          state: "ok",
          detail: `${platformName(runtime.platform)} ${runtime.runtimeVersion}`,
        }
      : xcodeOk
        ? {
            id: "runtime",
            label: "iOS Simulator runtime",
            state: "missing",
            detail: "None installed.",
            fix: "Add one in Xcode › Settings › Components.",
          }
        : {
            id: "runtime",
            label: "iOS Simulator runtime",
            state: "waiting",
            detail: "Checked after Xcode",
          },
    discovery?.workspace.projectPath === undefined
      ? { id: "project", label: "Project found", state: "waiting", detail: "Checked after Xcode" }
      : {
          id: "project",
          label: "Project found",
          state: "ok",
          detail: basename(discovery.workspace.projectPath),
        },
  ];
  const note =
    props.status === "failed" || (props.status === "unavailable" && !xcodeMissing)
      ? props.errorMessage
      : undefined;
  return {
    kind: "setup",
    title: "Set up the iOS Simulator",
    checks,
    ...(note === undefined ? {} : { note }),
  };
}

function appleDiagnostics(props: AppleWorkbenchPaneProps): DeviceDiagnostics {
  const stream = props.liveScreen?.status;
  const facts = [
    {
      label: "Live view",
      value:
        props.liveViewStopped === true
          ? "Off"
          : stream === "live"
            ? "Streaming"
            : stream === "connecting"
              ? "Connecting"
              : props.screenUrl !== undefined
                ? "Last screenshot"
                : "Not attached",
    },
    ...(props.discovery?.toolchain.xcodeVersion === undefined
      ? []
      : [{ label: "Xcode", value: props.discovery.toolchain.xcodeVersion }]),
    ...(props.actionFailure === undefined
      ? []
      : [{ label: "Last problem", value: deviceFailureDetail(props.actionFailure) }]),
  ];
  const running = (props.runtime?.active ?? [])
    .filter((progress) => progress.state !== "completed")
    .map((progress) => ({
      id: String(progress.actionId),
      label: deviceWord(progress.kind),
      step: deviceWord(progress.step),
      ...(props.onCancel === undefined
        ? {}
        : { onCancel: () => props.onCancel?.(progress.actionId) }),
    }));
  const recent = [...(props.runtime?.recentEvidence ?? [])]
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
    });
  return { facts, running, recent };
}

function appleInputIntent(
  simulatorId: Extract<AppleWorkbenchIntent, { kind: "tap" }>["simulatorId"],
  intent: DeviceInputIntent,
): AppleWorkbenchIntent {
  switch (intent.kind) {
    case "tap":
      return { kind: "tap", simulatorId, point: intent.point };
    case "swipe":
      return {
        kind: "swipe",
        simulatorId,
        point: intent.from,
        toPoint: intent.to,
        durationMs: intent.durationMs,
      };
    case "type-text":
      return { kind: "type-text", simulatorId, text: intent.text };
    case "key-press":
      return { kind: "key-press", simulatorId, key: intent.key };
  }
}

function simulatorChoice(simulator: AppleSimulatorRecord): DeviceChoice {
  return {
    id: String(simulator.simulatorId),
    name: simulator.name,
    os: `${platformName(simulator.platform)} ${simulator.runtimeVersion}`,
    state: simulator.state,
  };
}

function platformName(platform: AppleSimulatorRecord["platform"]): string {
  const names: Record<AppleSimulatorRecord["platform"], string> = {
    ios: "iOS",
    macos: "macOS",
    watchos: "watchOS",
    tvos: "tvOS",
    visionos: "visionOS",
  };
  return names[platform];
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
