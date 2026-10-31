import type {
  CaptureWindowList,
  CaptureWindowPermissionOutcome,
  CaptureWindowResult,
  CaptureWindowSummary,
} from "@octant/contracts/desktop-bridge";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import "./window-capture.css";

/** The host calls the composer's window capture needs; all three exist together or not at all. */
export interface WindowCaptureBridge {
  readonly listCaptureWindows: () => Promise<CaptureWindowList>;
  readonly requestCaptureWindowPermission: () => Promise<CaptureWindowPermissionOutcome>;
  readonly captureWindow: (windowId: string) => Promise<CaptureWindowResult>;
}

/** Window capture exists only where the host says it can capture; a web or phone client has none. */
export function windowCaptureBridge(
  host: Partial<WindowCaptureBridge> | undefined,
): WindowCaptureBridge | undefined {
  if (
    host?.listCaptureWindows === undefined ||
    host.requestCaptureWindowPermission === undefined ||
    host.captureWindow === undefined
  )
    return undefined;
  return {
    listCaptureWindows: host.listCaptureWindows,
    requestCaptureWindowPermission: host.requestCaptureWindowPermission,
    captureWindow: host.captureWindow,
  };
}

type Phase =
  | { readonly kind: "looking" }
  | { readonly kind: "explain"; readonly access: "not-determined" | "denied" | "restricted" }
  | { readonly kind: "asking" }
  | { readonly kind: "settings" }
  | { readonly kind: "pick"; readonly windows: ReadonlyArray<CaptureWindowSummary> }
  | { readonly kind: "capturing"; readonly windows: ReadonlyArray<CaptureWindowSummary> };

export interface WindowCaptureDialogProps {
  readonly bridge: WindowCaptureBridge;
  readonly onClose: () => void;
  /** The capture, as the image file the composer already knows how to attach. */
  readonly onCaptured: (file: File) => void;
  /** A reason nothing was attached, for the composer's status line. */
  readonly onNotice: (message: string) => void;
}

const SETTINGS_PATH = "System Settings > Privacy & Security > Screen Recording";

/**
 * Pick an open window and attach a picture of it. The host reads only window
 * titles to fill the list, asks macOS for Screen Recording only after the
 * person agrees here, and reads a window's pixels only once it is chosen.
 */
export function WindowCaptureDialog(props: WindowCaptureDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "looking" });
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const open = useRef(true);
  const { bridge, onClose, onCaptured, onNotice } = props;

  function close() {
    open.current = false;
    onClose();
  }

  async function look() {
    setPhase({ kind: "looking" });
    let list: CaptureWindowList;
    try {
      list = await bridge.listCaptureWindows();
    } catch {
      if (!open.current) return;
      onNotice("Octant could not list the open windows.");
      close();
      return;
    }
    if (!open.current) return;
    setPhase(
      list.kind === "permission-needed"
        ? { kind: "explain", access: list.access }
        : { kind: "pick", windows: list.windows },
    );
  }

  useEffect(() => {
    // Strict Mode runs this effect twice; the first cleanup must not leave the
    // dialog deaf to the answer the second run asks for.
    open.current = true;
    void look();
    return () => {
      open.current = false;
    };
    // The list is read once when the dialog opens.
  }, []);

  async function allow() {
    setPhase({ kind: "asking" });
    let outcome: CaptureWindowPermissionOutcome;
    try {
      outcome = await bridge.requestCaptureWindowPermission();
    } catch {
      if (!open.current) return;
      onNotice("Octant could not ask macOS for Screen Recording.");
      close();
      return;
    }
    if (!open.current) return;
    if (outcome.kind === "granted") await look();
    else setPhase({ kind: "settings" });
  }

  async function capture(
    windows: ReadonlyArray<CaptureWindowSummary>,
    picked: CaptureWindowSummary,
  ) {
    setPhase({ kind: "capturing", windows });
    let result: CaptureWindowResult;
    try {
      result = await bridge.captureWindow(picked.id);
    } catch {
      if (!open.current) return;
      onNotice("Octant could not capture that window.");
      close();
      return;
    }
    if (!open.current) return;
    if (result.kind === "captured") {
      onCaptured(
        new File([new Uint8Array(result.bytes)], captureFileName(result.name), {
          type: result.mimeType,
        }),
      );
      close();
    } else if (result.kind === "permission-needed") {
      setPhase({ kind: "explain", access: "denied" });
    } else {
      onNotice(
        result.kind === "gone"
          ? `${picked.name} closed before it could be captured.`
          : result.message,
      );
      close();
    }
  }

  const heading = headingFor(phase);
  return (
    <OctantDialog
      open
      className="octant-confirmation window-capture"
      describedBy={descriptionId}
      initialFocus={cancel}
      label={heading}
      labelledBy={titleId}
      onClose={() => {
        if (phase.kind !== "capturing" && phase.kind !== "asking") close();
      }}
    >
      <h2 className="octant-confirmation__title" id={titleId}>
        {heading}
      </h2>
      <p className="octant-confirmation__description" id={descriptionId}>
        {descriptionFor(phase)}
      </p>
      {phase.kind === "pick" || phase.kind === "capturing" ? (
        <ul aria-label="Open windows" className="window-capture__list">
          {phase.windows.map((window) => (
            <li key={window.id}>
              <OctantButton
                className="window-capture__window"
                disabled={phase.kind === "capturing"}
                onClick={() => void capture(phase.windows, window)}
                type="button"
                variant="ghost"
              >
                {window.name}
              </OctantButton>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <OctantButton
          disabled={phase.kind === "capturing" || phase.kind === "asking"}
          onClick={close}
          ref={cancel}
          size="sm"
          type="button"
          variant="outline"
        >
          {phase.kind === "settings" ? "Close" : "Cancel"}
        </OctantButton>
        {phase.kind === "explain" ? (
          <OctantButton onClick={() => void allow()} size="sm" type="button">
            {phase.access === "not-determined" ? "Continue" : "Open System Settings"}
          </OctantButton>
        ) : null}
      </div>
    </OctantDialog>
  );
}

function headingFor(phase: Phase): string {
  switch (phase.kind) {
    case "explain":
      return phase.access === "not-determined"
        ? "Allow Octant to capture a window?"
        : "Screen Recording is off for Octant";
    case "settings":
      return "Allow Screen Recording for Octant";
    case "pick":
    case "capturing":
      return "Capture a window";
    default:
      return "Capture a window";
  }
}

function descriptionFor(phase: Phase): string {
  switch (phase.kind) {
    case "looking":
      return "Looking for open windows…";
    case "asking":
      return "Waiting for macOS…";
    case "explain":
      return phase.access === "not-determined"
        ? "To attach a picture of a window, macOS needs your permission for Screen Recording, and asks once when you continue. Octant reads a window only after you pick it here, and the picture goes only to the thread you attach it to."
        : `Turn it on for Octant in ${SETTINGS_PATH}, then choose Capture window again. macOS may ask you to reopen Octant.`;
    case "settings":
      return `macOS has not allowed Screen Recording for Octant yet. Allow it in ${SETTINGS_PATH}, then choose Capture window again. macOS may ask you to reopen Octant.`;
    case "pick":
    case "capturing":
      return phase.windows.length === 0
        ? "No windows are open to capture."
        : "Choose the window to attach as an image. Nothing is captured until you choose.";
  }
}

/** A readable file name for the attachment: the window's title, with no path separators. */
function captureFileName(title: string): string {
  const safe = title
    .replace(/[\\/:\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `Window - ${safe.length === 0 ? "capture" : safe}.png`;
}
