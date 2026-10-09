import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { useOrderedDeviceInput, type DeviceInputIntent } from "./deviceInput";
import type {
  DeviceAction,
  DeviceChoice,
  DeviceDiagnostics,
  DevicePlatform,
  DeviceProblem,
  DeviceView,
} from "./deviceModel";
import { DeviceLine, type DeviceLineContent } from "./DeviceLine";
import { DevicePicker } from "./DevicePicker";
import { DeviceSetup } from "./DeviceSetup";
import { DeviceSpinner, DeviceStage } from "./DeviceStage";
import { DeviceToolbar, type DeviceDot, type DeviceMenuItem } from "./DeviceToolbar";

/** At this width the pane has room for Lock beside Home and a roomier stage. */
const WIDE_PANE_PX = 520;

export interface DevicePaneProps {
  readonly platform: DevicePlatform;
  readonly view: DeviceView;
  readonly devices: ReadonlyArray<DeviceChoice>;
  /** True while a request this pane started is still in flight. */
  readonly busy: boolean;
  /** Absent when this surface may only look: no control is offered at all. */
  readonly onAction?: (action: DeviceAction) => void;
  /** Where taps, swipes, typing, and the device's own buttons go, in order. */
  readonly onInput?: (intent: DeviceInputIntent) => void;
  /** Input reaches the device: a live grant, or a thread that is not approval-gated. */
  readonly inputAllowed: boolean;
  /** Approval-gated and no grant yet: ask before any input is sent. */
  readonly needsApproval: boolean;
  readonly problem?: DeviceProblem;
  readonly diagnostics: DeviceDiagnostics;
}

/**
 * The device-first pane for the iOS Simulator and the Android emulator: one
 * toolbar, at most one line for anything that needs the person, and the
 * device on a quiet stage. It draws what it is given and hands every request
 * back; approval, grants, and running requests stay with the surface above.
 */
export function DevicePane(props: DevicePaneProps) {
  const { view } = props;
  const label = props.platform === "ios" ? "iOS Simulator" : "Android emulator";
  const device = deviceOf(view);
  const deviceId = device?.id;
  const canAct = props.onAction !== undefined;
  const live = view.kind === "live" ? view : undefined;
  const hardware = live !== undefined && props.inputAllowed && props.onInput !== undefined;

  const rootRef = useRef<HTMLElement>(null);
  const wide = usePaneIsWide(rootRef);
  const [approvalDeferred, setApprovalDeferred] = useState(false);
  const [focusAllow, setFocusAllow] = useState(false);
  const [typing, setTyping] = useState(false);
  const [picking, setPicking] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // A dismissed line stays dismissed until the failure behind it clears: the
  // adapters rebuild the problem on every render, so it is matched by its words.
  const [dismissed, setDismissed] = useState<string>();
  const problemMessage = props.problem?.message;
  useEffect(() => {
    if (problemMessage === undefined) setDismissed(undefined);
  }, [problemMessage]);

  // A choice made about one device is not carried to the next one shown.
  useEffect(() => {
    setApprovalDeferred(false);
    setFocusAllow(false);
    setTyping(false);
    setPicking(false);
  }, [deviceId]);

  const enqueue = useOrderedDeviceInput({
    owner: live?.device.id ?? "",
    busy: props.busy,
    ...(props.onInput === undefined ? {} : { onInput: props.onInput }),
  });

  const act = (action: DeviceAction) => props.onAction?.(action);
  const approvalWanted = props.needsApproval && live !== undefined && canAct;
  const line = lineFor({
    view,
    problem:
      props.problem !== undefined && props.problem.message !== dismissed
        ? props.problem
        : undefined,
    onDismiss: () => setDismissed(props.problem?.message),
    approval:
      approvalWanted && !approvalDeferred
        ? {
            kind: "approval",
            deviceName: live.device.name,
            focusAllow,
            onAllow: () => act({ kind: "allow-input" }),
            onNotNow: () => {
              setApprovalDeferred(true);
              setFocusAllow(false);
            },
          }
        : undefined,
    typing:
      typing && hardware
        ? {
            kind: "type",
            deviceName: live.device.name,
            onClose: () => setTyping(false),
            onSend: (text) => enqueue({ kind: "type-text", text }, false),
          }
        : undefined,
    canAct,
    act,
  });
  const presented = toolbarState(view);
  const choosable = props.devices.filter((one) => one.state !== "unavailable");

  const onMenu = (item: DeviceMenuItem) => {
    if (item === "type-text") setTyping(true);
    else if (item === "lock") enqueue({ kind: "key-press", key: "lock" }, false);
    else if (item === "switch-device") setPicking(true);
    else if (item === "diagnostics") setDiagnosticsOpen(true);
    else if (item === "stop-live-view") act({ kind: "stop-live-view" });
    else act({ kind: "shutdown" });
  };

  return (
    <section
      aria-label={label}
      className="device-pane"
      data-platform={props.platform}
      data-wide={wide ? "true" : undefined}
      ref={rootRef}
    >
      <DeviceToolbar
        controls={{
          hardware,
          back: props.platform === "android",
          screenshot: live !== undefined && canAct && !props.busy,
          typeText: hardware,
          switchDevice: canAct && choosable.length > 0 && view.kind !== "setup",
          stopLiveView:
            live !== undefined &&
            canAct &&
            (live.liveView === "streaming" || live.liveView === "connecting"),
          shutdown: live !== undefined && canAct,
        }}
        {...(deviceId === undefined ? {} : { currentId: deviceId })}
        devices={props.devices}
        dot={presented.dot}
        label={label}
        onKey={(key) => enqueue({ kind: "key-press", key }, false)}
        onMenu={onMenu}
        onScreenshot={() => act({ kind: "screenshot" })}
        {...(canAct
          ? { onSelectDevice: (id: string) => act({ kind: "select", deviceId: id }) }
          : {})}
        {...(device?.os === undefined ? {} : { os: device.os })}
        state={presented.state}
        title={device?.name ?? label}
        {...(approvalWanted && approvalDeferred
          ? {
              viewOnly: {
                onShowApproval: () => {
                  setApprovalDeferred(false);
                  setFocusAllow(true);
                },
              },
            }
          : {})}
        wide={wide}
      />
      {line === undefined ? null : <DeviceLine content={line} />}
      <div className="device-stage">
        {picking || view.kind === "pick" ? (
          <DevicePicker
            busy={props.busy}
            {...(deviceId === undefined ? {} : { currentId: deviceId })}
            devices={props.devices}
            {...(picking ? { onCancel: () => setPicking(false) } : {})}
            {...(canAct
              ? {
                  onBoot: (id: string) => {
                    setPicking(false);
                    act({ kind: "boot", deviceId: id });
                  },
                  onShow: (id: string) => {
                    setPicking(false);
                    act({ kind: "select", deviceId: id });
                  },
                }
              : {})}
            title={props.platform === "ios" ? "Choose a Simulator" : "Choose an emulator"}
          />
        ) : (
          <StageFor
            canAct={canAct}
            enqueue={enqueue}
            hardware={hardware}
            platform={props.platform}
            view={view}
            act={act}
          />
        )}
        {diagnosticsOpen ? (
          <DeviceDiagnosticsCard
            diagnostics={props.diagnostics}
            onClose={() => setDiagnosticsOpen(false)}
          />
        ) : null}
      </div>
    </section>
  );
}

function StageFor(props: {
  readonly view: DeviceView;
  readonly platform: DevicePlatform;
  readonly hardware: boolean;
  readonly canAct: boolean;
  readonly enqueue: ReturnType<typeof useOrderedDeviceInput>;
  readonly act: (action: DeviceAction) => void;
}) {
  const { view } = props;
  const blank = { kind: "none" } as const;
  switch (view.kind) {
    case "checking":
      return (
        <DeviceStage
          active={false}
          caption={
            <>
              <DeviceSpinner />
              Checking this Mac…
            </>
          }
          enqueue={props.enqueue}
          ghost
          name="Device"
          platform={props.platform}
          screen={blank}
        />
      );
    case "setup":
      return (
        <DeviceSetup
          checking={false}
          checks={view.checks}
          {...(view.note === undefined ? {} : { note: view.note })}
          {...(props.canAct ? { onCheckAgain: () => props.act({ kind: "check-again" }) } : {})}
          title={view.title}
        />
      );
    case "pick":
      return null;
    case "booting":
    case "shutting-down":
      return (
        <DeviceStage
          active={false}
          caption={
            <>
              <DeviceSpinner />
              {view.kind === "booting" ? "Booting" : "Shutting down"} {view.device.name}…
            </>
          }
          enqueue={props.enqueue}
          name={view.device.name}
          platform={props.platform}
          screen={blank}
        />
      );
    case "live": {
      const lost = view.liveView === "lost";
      const connecting = view.screen.kind === "connecting";
      return (
        <DeviceStage
          active={props.hardware && (view.screen.kind === "stream" || view.screen.kind === "still")}
          {...(lost && view.screen.kind === "still" ? { badge: "Last frame" } : {})}
          {...(connecting
            ? {
                caption: (
                  <>
                    <DeviceSpinner />
                    Connecting to {view.device.name}…
                  </>
                ),
              }
            : view.screen.kind === "none"
              ? { caption: "Take a screenshot to see the screen." }
              : {})}
          dimmed={lost}
          enqueue={props.enqueue}
          name={view.device.name}
          platform={props.platform}
          screen={view.screen.kind === "connecting" ? blank : view.screen}
          {...(view.transport === undefined ? {} : { status: view.transport })}
        />
      );
    }
    case "last-screen":
      return (
        <DeviceStage
          active={false}
          badge={view.reason === "restart" ? "Last screen" : "Last frame"}
          dimmed
          enqueue={props.enqueue}
          name={view.device?.name ?? "Device"}
          platform={props.platform}
          screen={view.still === undefined ? blank : { kind: "still", url: view.still }}
        />
      );
    case "unavailable":
      return (
        <DeviceStage
          active={false}
          enqueue={props.enqueue}
          ghost
          name={view.device?.name ?? "Device"}
          platform={props.platform}
          screen={blank}
        />
      );
  }
}

function DeviceDiagnosticsCard(props: {
  readonly diagnostics: DeviceDiagnostics;
  readonly onClose: () => void;
}) {
  const headingId = useId();
  const { diagnostics } = props;
  return (
    <section
      aria-labelledby={headingId}
      className="device-card device-card--sheet"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className="device-card__head">
        <h2 className="device-card__title" id={headingId}>
          Diagnostics
        </h2>
        <OctantIconButton
          label="Close diagnostics"
          onClick={props.onClose}
          size="icon-sm"
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </OctantIconButton>
      </div>
      <dl className="device-facts">
        {diagnostics.facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="device-card__subtitle">Running</h3>
      {diagnostics.running.length === 0 ? (
        <p className="device-card__lede">Nothing is running.</p>
      ) : (
        <ul className="device-rows">
          {diagnostics.running.map((row) => (
            <li key={row.id}>
              <span>{row.label}</span>
              <span className="device-rows__meta">{row.step}</span>
              {row.onCancel === undefined ? null : (
                <OctantButton onClick={row.onCancel} size="sm" type="button" variant="ghost">
                  Cancel
                </OctantButton>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="device-card__subtitle">Recent</h3>
      {diagnostics.recent.length === 0 ? (
        <p className="device-card__lede">Nothing has been recorded yet.</p>
      ) : (
        <ul className="device-rows">
          {diagnostics.recent.map((row) => (
            <li key={row.id}>
              <span>{row.label}</span>
              <span className="device-rows__meta">{row.outcome}</span>
              {row.detail === undefined ? null : (
                <span className="device-rows__detail">{row.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function deviceOf(view: DeviceView): DeviceChoice | undefined {
  switch (view.kind) {
    case "booting":
    case "shutting-down":
    case "live":
      return view.device;
    case "last-screen":
    case "unavailable":
      return view.device;
    default:
      return undefined;
  }
}

function toolbarState(view: DeviceView): { readonly state: string; readonly dot: DeviceDot } {
  switch (view.kind) {
    case "checking":
      return { state: "Checking…", dot: "busy" };
    case "setup":
      return { state: "Not set up", dot: "idle" };
    case "pick":
      return { state: "No device running", dot: "idle" };
    case "booting":
      return { state: "Booting", dot: "busy" };
    case "shutting-down":
      return { state: "Shutting down", dot: "busy" };
    case "live":
      switch (view.liveView) {
        case "connecting":
          return { state: "Connecting", dot: "busy" };
        case "lost":
          return { state: "Live view lost", dot: "lost" };
        case "stopped":
          return { state: "Live view off", dot: "idle" };
        default:
          return { state: "Running", dot: "running" };
      }
    case "last-screen":
      return view.reason === "restart"
        ? { state: "Last screen", dot: "idle" }
        : { state: "Live view lost", dot: "lost" };
    case "unavailable":
      return { state: "Unavailable", dot: "idle" };
  }
}

function lineFor(input: {
  readonly view: DeviceView;
  readonly problem: DeviceProblem | undefined;
  readonly onDismiss: () => void;
  readonly approval: DeviceLineContent | undefined;
  readonly typing: DeviceLineContent | undefined;
  readonly canAct: boolean;
  readonly act: (action: DeviceAction) => void;
}): DeviceLineContent | undefined {
  if (input.problem !== undefined) {
    return { kind: "error", problem: input.problem, onDismiss: input.onDismiss };
  }
  if (input.approval !== undefined) return input.approval;
  if (input.typing !== undefined) return input.typing;
  const reconnect = (label: string) =>
    input.canAct ? { fix: { label, run: () => input.act({ kind: "reconnect" }) } } : {};
  const { view } = input;
  if (view.kind === "live" && view.liveView === "lost") {
    return {
      kind: "notice",
      problem: {
        message:
          view.screen.kind === "still"
            ? "The live view stopped. This is the last screenshot."
            : "The live view stopped.",
        ...reconnect("Reconnect"),
      },
    };
  }
  if (view.kind === "live" && view.liveView === "stopped") {
    return { kind: "notice", problem: { message: "Live view is off.", ...reconnect("Resume") } };
  }
  if (view.kind === "last-screen") {
    return {
      kind: "notice",
      problem: {
        message:
          view.reason === "restart"
            ? "Showing the last screen from before Octant restarted."
            : "The live view stopped.",
        ...reconnect("Reconnect"),
      },
    };
  }
  if (view.kind === "unavailable") return { kind: "notice", problem: { message: view.message } };
  return undefined;
}

function usePaneIsWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWide(entry.contentRect.width >= WIDE_PANE_PX);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}
