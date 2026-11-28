import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import type { DesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import type { DesktopViewId, HostDisplayRequest } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";

type Input = Extract<HostDisplayRequest, { action: "input" }>["event"];
type Point = { readonly x: number; readonly y: number };

// Physical key codes accepted by the packaged Mac display helper.
const namedKeys = new Set([
  "Enter",
  "Equal",
  "Minus",
  "BracketLeft",
  "BracketRight",
  "Quote",
  "Semicolon",
  "Backslash",
  "Comma",
  "Slash",
  "Period",
  "Tab",
  "Space",
  "Backquote",
  "Backspace",
  "Escape",
  "Home",
  "PageUp",
  "Delete",
  "End",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
]);

export function HostDisplayPane({
  client,
  threadId,
}: {
  readonly client: DesktopPaneClient;
  readonly threadId: string;
}) {
  const [view, setView] = useState<DesktopViewId>();
  const [control, setControl] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [picture, setPicture] = useState<{ jpeg: string; geometry: string }>();
  const active = useRef<DesktopViewId>(undefined);
  const alive = useRef(false);
  const controlling = useRef(false);
  const queue = useRef(Promise.resolve());
  const image = useRef<HTMLImageElement>(null);
  const lastClick = useRef<{ x: number; y: number; at: number }>(undefined);
  const down = useRef<
    (Point & { geometry: string; button: number; pointerId: number }) | undefined
  >(undefined);
  const close = useCallback(() => {
    const viewId = active.current;
    active.current = undefined;
    controlling.current = false;
    down.current = undefined;
    lastClick.current = undefined;
    if (viewId)
      void client
        .request({ kind: "host-display", action: "close", threadId, viewId })
        .catch(() => undefined);
    if (alive.current) {
      setView(undefined);
      setControl(false);
      setPicture(undefined);
    }
  }, [client, threadId]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      close();
    };
  }, [close]);
  useEffect(() => {
    if (!view) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const answer = await client.request(
          { kind: "host-display", action: "frame", threadId, viewId: view },
          abort.signal,
        );
        if (abort.signal.aborted || active.current !== view) return;
        if (answer.status === "host-frame") setPicture(answer);
        else if (answer.status !== "no-frame") throw new Error();
        timer = setTimeout(() => void read(), document.visibilityState === "visible" ? 250 : 5000);
      } catch {
        if (!abort.signal.aborted && active.current === view) {
          close();
          setNotice(
            "This computer's display disconnected. Check Computer use permissions and that the Mac is unlocked.",
          );
        }
      }
    };
    void read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [client, threadId, view, close]);
  const open = async () => {
    setPending(true);
    setNotice("");
    try {
      const answer = await client.request({ kind: "host-display", action: "open", threadId });
      if (answer.status !== "viewing") throw new Error();
      if (!alive.current) {
        void client
          .request({ kind: "host-display", action: "close", threadId, viewId: answer.viewId })
          .catch(() => undefined);
        return;
      }
      active.current = answer.viewId;
      setView(answer.viewId);
    } catch {
      if (alive.current) setNotice("This computer's display is unavailable or already open.");
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const changeControl = async () => {
    if (!view) return;
    setPending(true);
    controlling.current = false;
    down.current = undefined;
    lastClick.current = undefined;
    try {
      await queue.current;
      if (active.current !== view) return;
      const answer = await client.request({
        kind: "host-display",
        action: control ? "hand-back" : "take-control",
        threadId,
        viewId: view,
      });
      if (answer.status !== "delivered") throw new Error();
      if (active.current !== view) return;
      controlling.current = !control;
      setControl(!control);
      setNotice("");
      if (!control) image.current?.focus();
    } catch {
      if (active.current === view) {
        close();
        setNotice("This computer could not confirm who has control. Open the display again.");
      }
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const geometry = picture?.geometry;
  const send = useCallback(
    (event: Input, frameGeometry = geometry) => {
      if (!view || !frameGeometry || !controlling.current) return;
      queue.current = queue.current
        .then(async () => {
          if (active.current !== view) return;
          const answer = await client.request({
            kind: "host-display",
            action: "input",
            threadId,
            viewId: view,
            geometry: frameGeometry,
            event,
          });
          if (answer.status !== "delivered") throw new Error();
        })
        .catch(() => {
          if (active.current === view) {
            close();
            setNotice("This computer could not confirm that input was delivered.");
          }
        });
    },
    [client, close, threadId, view, geometry],
  );
  useEffect(() => {
    const element = image.current;
    if (!element || !control) return;
    const wheel = (e: WheelEvent) => {
      // Chromium also delivers trackpad pinch-to-zoom as Ctrl-wheel.
      if (!controlling.current || e.ctrlKey) return;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      e.preventDefault();
      const clamp = (n: number) => Math.max(-10000, Math.min(10000, Math.round(n)));
      send({
        kind: "scroll",
        x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
        deltaX: clamp(e.deltaX),
        deltaY: clamp(e.deltaY),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [control, send]);
  function point(e: PointerEvent<HTMLImageElement>): Point {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
  }
  return (
    <section aria-label="This computer's display">
      {view ? (
        <>
          <OctantButton disabled={pending || !picture} onClick={() => void changeControl()}>
            {control ? "Hand back to agent" : "Take control"}
          </OctantButton>
          <OctantButton onClick={close} variant="outline">
            Close display
          </OctantButton>
          {picture && (
            <img
              ref={image}
              alt="Mac display"
              className="host-display__image"
              src={"data:image/jpeg;base64," + picture.jpeg}
              tabIndex={control ? 0 : -1}
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (!controlling.current || down.current || (e.button !== 0 && e.button !== 2))
                  return;
                e.preventDefault();
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                down.current = {
                  ...point(e),
                  geometry: picture.geometry,
                  button: e.button,
                  pointerId: e.pointerId,
                };
              }}
              onLostPointerCapture={(e) => {
                if (down.current?.pointerId === e.pointerId) down.current = undefined;
              }}
              onPointerUp={(e) => {
                const start = down.current;
                if (!start || start.pointerId !== e.pointerId) return;
                down.current = undefined;
                if (e.button !== start.button) return;
                const end = point(e);
                if (Math.hypot(end.x - start.x, end.y - start.y) > 0.004) {
                  lastClick.current = undefined;
                  if (start.button !== 0) return;
                  send(
                    { kind: "drag", x: start.x, y: start.y, endX: end.x, endY: end.y },
                    start.geometry,
                  );
                } else {
                  const previous = lastClick.current;
                  const now = performance.now();
                  const twice =
                    e.button === 0 &&
                    previous &&
                    now - previous.at < 500 &&
                    Math.hypot(end.x - previous.x, end.y - previous.y) < 0.004;
                  lastClick.current = e.button === 0 && !twice ? { ...end, at: now } : undefined;
                  send(
                    {
                      kind: e.button === 2 ? "right-click" : twice ? "double-click" : "click",
                      ...end,
                    },
                    start.geometry,
                  );
                }
              }}
              onKeyDown={(e) => {
                if (!controlling.current || e.nativeEvent.isComposing) return;
                if (e.key === "Escape" && e.shiftKey) {
                  e.currentTarget.blur();
                  return;
                }
                if (["Shift", "Meta", "Alt", "Control", "Dead"].includes(e.key)) return;
                e.preventDefault();
                if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
                  send({ kind: "text", text: e.key });
                else {
                  const code = e.code === "NumpadEnter" ? "Enter" : e.code;
                  if (
                    !namedKeys.has(code) &&
                    !/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2]))$/.test(code)
                  )
                    return;
                  send({
                    kind: "key",
                    code,
                    shift: e.shiftKey,
                    ctrl: e.ctrlKey,
                    meta: e.metaKey,
                    alt: e.altKey,
                  });
                }
              }}
            />
          )}
        </>
      ) : (
        <OctantButton disabled={pending} onClick={() => void open()} variant="outline">
          Show Mac desktop
        </OctantButton>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
