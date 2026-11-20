import {
  createPairedBrowserControlClient,
  type PairedBrowserControlClient,
} from "@octant/client-runtime";
import {
  MAX_PAIRED_BROWSER_TEXT_LENGTH,
  type PairedBrowserChooserId,
  type PairedBrowserInput,
  type PairedBrowserLeaseId,
  type PairedBrowserStreamEvent,
  type PairedBrowserTarget,
  type PairedBrowserWithheldReason,
} from "@octant/contracts/paired-browser-control";
import { useEffect, useMemo, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";

export interface PairedBrowserHoldStageProps {
  readonly lease: {
    readonly leaseId: PairedBrowserLeaseId;
    readonly expiresAt: string;
    readonly target: PairedBrowserTarget;
  };
  readonly client?: PairedBrowserControlClient;
  readonly onHandBack: () => void;
  readonly onEnded: (notice?: string) => void;
}

interface LiveFrame {
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
  readonly src: string;
}

interface PendingChooser {
  readonly chooserId: PairedBrowserChooserId;
  readonly accept: ReadonlyArray<string>;
  readonly multiple: boolean;
}

const WITHHELD_COPY: Readonly<Record<PairedBrowserWithheldReason, string>> = {
  "private-custody": "Frames are paused while a login fill or private script is active.",
  "native-prompt": "Frames are paused while a prompt is open on the computer.",
  "outside-document": "This tab moved outside the held page. Finish this on the computer.",
};

function isLocalPasteShortcut(event: {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    (event.key.toLowerCase() === "v" || event.code === "KeyV")
  );
}

/**
 * Live person-only screencast and touch/scroll/key/text/IME surface for a
 * paired browser holding a desktop Browser page. Never dispatches mouse events,
 * hides frames when the tab goes to the background, and converts device paste
 * gestures into text events without reading the host clipboard.
 */
export function PairedBrowserHoldStage(props: PairedBrowserHoldStageProps) {
  const control = useMemo(
    () =>
      props.client ??
      createPairedBrowserControlClient({
        fetch: (path, init) => fetch(path, { ...init, credentials: "same-origin" }),
      }),
    [props.client],
  );
  const [frame, setFrame] = useState<LiveFrame | undefined>();
  const [withheld, setWithheld] = useState<PairedBrowserWithheldReason | undefined>();
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  const [notice, setNotice] = useState<string | undefined>();
  const [chooser, setChooser] = useState<PendingChooser | undefined>();
  const sequence = useRef(0);
  const dragging = useRef<Array<{ readonly x: number; readonly y: number }>>([]);
  const composing = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const sendEvents = (events: ReadonlyArray<PairedBrowserInput>) => {
    if (events.length === 0) return;
    sequence.current += 1;
    const seq = sequence.current;
    void control.sendInput(props.lease.leaseId, seq, events).then((result) => {
      if (result.status === "refused") {
        if (result.reason === "stale-frame") {
          setNotice("The page changed before that tap landed.");
        } else if (result.reason === "lease-ended" || result.reason === "authority-ended") {
          props.onEnded("Remote control ended. Finish this on the computer or take over again.");
        } else if (result.reason === "rate-limited") {
          setNotice("Slow down — input rate limit reached.");
        }
      }
    });
  };

  useEffect(() => {
    const onVisibility = () => {
      const nextHidden = document.visibilityState === "hidden";
      setHidden(nextHidden);
      if (nextHidden) setFrame(undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const handleEvent = (event: PairedBrowserStreamEvent) => {
      if (event.kind === "frame") {
        if (document.visibilityState === "hidden") return;
        setWithheld(undefined);
        setFrame({
          frameId: event.frameId,
          width: event.viewport.width,
          height: event.viewport.height,
          src: `data:image/jpeg;base64,${event.jpegBase64}`,
        });
        return;
      }
      if (event.kind === "withheld") {
        setFrame(undefined);
        setWithheld(event.reason);
        return;
      }
      if (event.kind === "file-chooser") {
        setChooser({
          chooserId: event.chooserId,
          accept: event.accept,
          multiple: event.multiple,
        });
        return;
      }
      if (event.kind === "reclaimed-locally") {
        setFrame(undefined);
        props.onEnded("Reclaimed on the computer.");
        return;
      }
      setFrame(undefined);
      props.onEnded(
        event.reason === "handed-back"
          ? "Handed back to the agent."
          : "Remote control ended. The page stays held on the computer.",
      );
    };

    void control
      .stream({
        leaseId: props.lease.leaseId,
        onEvent: handleEvent,
        signal: abort.signal,
      })
      .catch(() => undefined);

    return () => {
      abort.abort();
    };
  }, [control, props.lease.leaseId, props.onEnded]);

  const pointFromEvent = (clientX: number, clientY: number) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return undefined;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  return (
    <div
      aria-label="Paired remote Browser control"
      className="browser-workspace__remote browser-workspace__remote--focused"
      onCompositionEnd={(event) => {
        composing.current = false;
        const text = event.data.slice(0, MAX_PAIRED_BROWSER_TEXT_LENGTH);
        sendEvents([{ kind: "composition", phase: "commit", text }]);
      }}
      onCompositionStart={(event) => {
        composing.current = true;
        sendEvents([
          {
            kind: "composition",
            phase: "start",
            text: event.data.slice(0, MAX_PAIRED_BROWSER_TEXT_LENGTH),
          },
        ]);
      }}
      onCompositionUpdate={(event) => {
        sendEvents([
          {
            kind: "composition",
            phase: "update",
            text: event.data.slice(0, MAX_PAIRED_BROWSER_TEXT_LENGTH),
          },
        ]);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setNotice("Right-click and hover are not offered remotely. Finish this on the computer.");
      }}
      onKeyDown={(event) => {
        if (composing.current) return;
        // Let Ctrl+V / Cmd+V reach the browser's native paste event so onPaste
        // sends the device's clipboard as text instead of forwarding a host paste key.
        if (isLocalPasteShortcut(event)) return;
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          sendEvents([{ kind: "text", text: event.key }]);
          return;
        }
        event.preventDefault();
        sendEvents([
          {
            kind: "key",
            phase: "down",
            key: event.key,
            code: event.code || event.key,
            modifiers: {
              alt: event.altKey,
              control: event.ctrlKey,
              meta: event.metaKey,
              shift: event.shiftKey,
            },
          },
        ]);
      }}
      onKeyUp={(event) => {
        if (composing.current) return;
        if (isLocalPasteShortcut(event)) return;
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return;
        event.preventDefault();
        sendEvents([
          {
            kind: "key",
            phase: "up",
            key: event.key,
            code: event.code || event.key,
            modifiers: {
              alt: event.altKey,
              control: event.ctrlKey,
              meta: event.metaKey,
              shift: event.shiftKey,
            },
          },
        ]);
      }}
      onPaste={(event) => {
        event.preventDefault();
        const pasted = event.clipboardData.getData("text/plain");
        if (pasted.length === 0) return;
        const chunks: Array<PairedBrowserInput> = [];
        for (let offset = 0; offset < pasted.length; offset += MAX_PAIRED_BROWSER_TEXT_LENGTH) {
          chunks.push({
            kind: "text",
            text: pasted.slice(offset, offset + MAX_PAIRED_BROWSER_TEXT_LENGTH),
          });
          if (chunks.length >= 16) break;
        }
        sendEvents(chunks);
      }}
      onWheel={(event) => {
        if (frame === undefined) return;
        const pt = pointFromEvent(event.clientX, event.clientY) ?? { x: 0.5, y: 0.5 };
        sendEvents([
          {
            kind: "scroll",
            frameId: frame.frameId,
            x: pt.x,
            y: pt.y,
            deltaX: Math.max(-2000, Math.min(2000, event.deltaX)),
            deltaY: Math.max(-2000, Math.min(2000, event.deltaY)),
          },
        ]);
      }}
      tabIndex={0}
    >
      <div className="row" style={{ gap: 8, padding: "6px 10px", alignItems: "center" }}>
        <span>Holding page remotely</span>
        <OctantButton onClick={props.onHandBack} size="sm" type="button">
          Hand back
        </OctantButton>
        <OctantButton
          onClick={() => {
            void control.release(props.lease.leaseId).finally(() => {
              props.onEnded("Stopped remote control. The page stays held on the computer.");
            });
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Stop remote control
        </OctantButton>
      </div>
      {notice === undefined ? null : <OctantAlert tone="warning">{notice}</OctantAlert>}
      {chooser === undefined ? null : (
        <OctantAlert tone="neutral">
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span>The page asked for a file from this device.</span>
            <input
              accept={chooser.accept.join(",")}
              hidden
              multiple={chooser.multiple}
              onChange={(event) => {
                const picked = event.currentTarget.files?.[0];
                if (picked === undefined) return;
                void picked.arrayBuffer().then((buf) =>
                  control
                    .uploadFile({
                      leaseId: props.lease.leaseId,
                      chooserId: chooser.chooserId,
                      fileName: picked.name,
                      bytes: new Uint8Array(buf),
                      ...(picked.type.length > 0 ? { mediaType: picked.type } : {}),
                    })
                    .then((res) => {
                      setChooser(undefined);
                      if (res.status === "refused") {
                        setNotice("That file could not be uploaded to the page.");
                      }
                    }),
                );
              }}
              ref={fileInputRef}
              type="file"
            />
            <OctantButton
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="secondary"
            >
              Choose file
            </OctantButton>
          </div>
        </OctantAlert>
      )}
      {hidden ? (
        <p className="browser-workspace__local-note">
          Frame hidden while tab is in the background.
        </p>
      ) : withheld !== undefined ? (
        <p className="browser-workspace__local-note">{WITHHELD_COPY[withheld]}</p>
      ) : frame === undefined ? (
        <p className="browser-workspace__local-note">Waiting for live frame…</p>
      ) : (
        <img
          alt="Live person-only Browser frame"
          draggable={false}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const pt = pointFromEvent(event.clientX, event.clientY);
            if (pt !== undefined) dragging.current = [pt];
          }}
          onPointerMove={(event) => {
            if (dragging.current.length === 0 || dragging.current.length >= 64) return;
            const pt = pointFromEvent(event.clientX, event.clientY);
            if (pt !== undefined) dragging.current.push(pt);
          }}
          onPointerUp={(event) => {
            if (event.button !== 0) return;
            const points = dragging.current;
            dragging.current = [];
            const end = pointFromEvent(event.clientX, event.clientY);
            if (points.length === 0 && end === undefined) return;
            const start = points[0] ?? end;
            if (start === undefined) return;
            const moved =
              end !== undefined &&
              Math.hypot(end.x - start.x, end.y - start.y) > 0.015 &&
              points.length >= 2;
            if (moved) {
              sendEvents([
                {
                  kind: "drag",
                  frameId: frame.frameId,
                  points: end === undefined ? points : [...points.slice(0, 63), end],
                },
              ]);
            } else {
              sendEvents([{ kind: "tap", frameId: frame.frameId, x: start.x, y: start.y }]);
            }
          }}
          ref={imgRef}
          src={frame.src}
          style={{ display: "block", width: "100%", height: "auto", touchAction: "none" }}
        />
      )}
    </div>
  );
}
