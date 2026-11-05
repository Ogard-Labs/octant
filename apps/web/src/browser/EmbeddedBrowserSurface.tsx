import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  decodeHumanBrowserRequest,
  type HumanBrowserInput,
  type HumanBrowserResult,
  MAX_HUMAN_FRAME_WIDTH,
  MAX_HUMAN_FRAME_HEIGHT,
} from "@octant/contracts/browser-presentation";
import type { OctantHostBridge, BrowserSurfaceState } from "../shell/hostBridge";

export function EmbeddedBrowserSurface(props: {
  readonly bridge: Pick<OctantHostBridge, "presentBrowser">;
  readonly contextId: string;
  readonly threadId: string;
  readonly overlaySelector: string;
  readonly onState: (state: BrowserSurfaceState) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [frame, setFrame] = useState<
    Extract<HumanBrowserResult, { status: "frame" }> & { readonly presentationId: string }
  >();
  const currentPresentation = useRef<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const displayed = useRef(0);
  const heldKeys = useRef(new Map<string, string>());
  const heldPointers = useRef(new Set<number>());
  const releaseInput = useRef<() => void>(() => {});
  const sendInput = useRef<(input: HumanBrowserInput) => void>(() => {});
  useEffect(() => {
    const resume = () => {
      if (!document.hidden) setAttempt((value) => value + 1);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    const element = mount.current;
    const present = props.bridge.presentBrowser;
    if (element === null || present === undefined) return;
    let disposed = false;
    let presentationId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let lastLayout = "";
    let errors = 0;
    let lastStateAt = 0;
    setFailed(false);
    setFrame(undefined);
    displayed.current = 0;
    const identity = { contextId: props.contextId, threadId: props.threadId };
    const execute = (request: Readonly<Record<string, unknown>>) =>
      present(decodeHumanBrowserRequest({ ...identity, ...request }));
    releaseInput.current = () => {
      heldKeys.current.clear();
      heldPointers.current.clear();
      if (disposed || presentationId === undefined) return;
      const previous = presentationId;
      presentationId = undefined;
      currentPresentation.current = undefined;
      displayed.current = 0;
      setFrame(undefined);
      void execute({ kind: "detach", presentationId: previous }).catch(() => {});
    };
    sendInput.current = (input) => {
      if (
        disposed ||
        !visible ||
        displayed.current === 0 ||
        presentationId === undefined ||
        document.activeElement !== element ||
        document.querySelector(props.overlaySelector) !== null
      )
        return;
      void execute({
        kind: "input",
        presentationId,
        frameSequence: displayed.current,
        input,
      }).catch(() => {});
    };
    const read = async () => {
      try {
        if (presentationId === undefined) {
          const attached = await execute({ kind: "attach" });
          if (attached.status !== "attached") throw new Error("Browser attachment refused.");
          if (disposed) {
            void execute({ kind: "detach", presentationId: attached.presentationId }).catch(
              () => {},
            );
            return;
          }
          presentationId = attached.presentationId;
          currentPresentation.current = presentationId;
          lastLayout = "";
          displayed.current = 0;
        }
        const rect = element.getBoundingClientRect();
        const layout = {
          width: Math.max(1, Math.min(MAX_HUMAN_FRAME_WIDTH, Math.floor(rect.width))),
          height: Math.max(1, Math.min(MAX_HUMAN_FRAME_HEIGHT, Math.floor(rect.height))),
          visible:
            !document.hidden &&
            rect.width > 0 &&
            rect.height > 0 &&
            element.getClientRects().length > 0 &&
            document.querySelector(props.overlaySelector) === null,
        };
        visible = layout.visible;
        const serialized = JSON.stringify(layout);
        if (serialized !== lastLayout) {
          displayed.current = 0;
          setFrame(undefined);
          const result = await execute({ kind: "layout", presentationId, layout });
          if (result.status !== "accepted") throw new Error("Browser layout refused.");
          lastLayout = serialized;
        }
        if (disposed) return;
        if (visible) {
          const frameOwner = presentationId;
          const next = await execute({
            kind: "frame",
            presentationId: frameOwner,
            acknowledgement: displayed.current,
          });
          if (disposed) return;
          if (presentationId !== frameOwner) {
            timer = setTimeout(() => void read(), 70);
            return;
          }
          if (next.status === "refused") {
            presentationId = undefined;
            currentPresentation.current = undefined;
            setFrame(undefined);
            displayed.current = 0;
            throw new Error("Browser presentation ended.");
          } else if (next.status === "frame") setFrame({ ...next, presentationId: frameOwner });
          if (presentationId !== undefined && performance.now() - lastStateAt > 500) {
            const state = await execute({ kind: "state", presentationId });
            if (!disposed && presentationId === frameOwner && state.status === "state")
              props.onState(state.state);
            lastStateAt = performance.now();
          }
        }
        errors = 0;
      } catch {
        errors += 1;
        if (errors >= 3 && !disposed) {
          setFailed(true);
          return;
        }
      }
      if (!disposed) timer = setTimeout(() => void read(), 70);
    };
    void read();
    return () => {
      disposed = true;
      heldKeys.current.clear();
      heldPointers.current.clear();
      currentPresentation.current = undefined;
      visible = false;
      sendInput.current = () => {};
      releaseInput.current = () => {};
      if (timer !== undefined) clearTimeout(timer);
      if (presentationId !== undefined)
        void execute({ kind: "detach", presentationId }).catch(() => {});
    };
  }, [
    props.bridge,
    props.contextId,
    props.threadId,
    props.overlaySelector,
    props.onState,
    attempt,
  ]);

  const point = (clientX: number, clientY: number) => {
    const rect = image.current?.getBoundingClientRect();
    if (rect === undefined || frame === undefined || rect.width <= 0 || rect.height <= 0)
      return undefined;
    return {
      x: Math.min(
        frame.width - 1,
        Math.max(0, Math.floor(((clientX - rect.left) * frame.width) / rect.width)),
      ),
      y: Math.min(
        frame.height - 1,
        Math.max(0, Math.floor(((clientY - rect.top) * frame.height) / rect.height)),
      ),
    };
  };
  const modifiers = (event: {
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }): Array<"shift" | "control" | "alt" | "meta"> => [
    ...(event.shiftKey ? ["shift" as const] : []),
    ...(event.ctrlKey ? ["control" as const] : []),
    ...(event.altKey ? ["alt" as const] : []),
    ...(event.metaKey ? ["meta" as const] : []),
  ];
  return (
    <div
      ref={mount}
      tabIndex={0}
      aria-label="Embedded Browser page"
      title="Control-Escape moves focus out of the page"
      style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          releaseInput.current();
      }}
      onPointerCancel={() => releaseInput.current()}
      onLostPointerCapture={(event) => {
        if (heldPointers.current.has(event.pointerId)) releaseInput.current();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        heldPointers.current.add(event.pointerId);
        const p = point(event.clientX, event.clientY);
        if (p !== undefined)
          sendInput.current({
            type: "mouseDown",
            ...p,
            button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
            clickCount: Math.min(2, Math.max(1, event.detail)),
            modifiers: modifiers(event),
          });
      }}
      onPointerUp={(event) => {
        heldPointers.current.delete(event.pointerId);
        const p = point(event.clientX, event.clientY);
        if (p !== undefined)
          sendInput.current({
            type: "mouseUp",
            ...p,
            button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
            clickCount: 1,
            modifiers: modifiers(event),
          });
      }}
      onPointerMove={(event) => {
        const p = point(event.clientX, event.clientY);
        if (p !== undefined)
          sendInput.current({
            type: "mouseMove",
            ...p,
            button: "left",
            clickCount: 0,
            modifiers: modifiers(event),
          });
      }}
      onWheel={(event) => {
        const p = point(event.clientX, event.clientY);
        if (p !== undefined)
          sendInput.current({
            type: "mouseWheel",
            ...p,
            deltaX: Math.max(-2_000, Math.min(2_000, -event.deltaX)),
            deltaY: Math.max(-2_000, Math.min(2_000, -event.deltaY)),
            modifiers: modifiers(event),
          });
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.blur();
          return;
        }
        if (
          event.nativeEvent.isComposing ||
          (event.metaKey && ["q", "w"].includes(event.key.toLowerCase()))
        )
          return;
        event.preventDefault();
        const physical = event.code || event.key;
        const keyCode = heldKeys.current.get(physical) ?? event.key;
        heldKeys.current.set(physical, keyCode);
        sendInput.current({ type: "keyDown", keyCode, modifiers: modifiers(event) });
        if (event.key === "Enter") sendInput.current({ type: "char", keyCode: "\r" });
        else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
          sendInput.current({ type: "char", keyCode: event.key });
      }}
      onKeyUp={(event) => {
        if (
          event.nativeEvent.isComposing ||
          (event.metaKey && ["q", "w"].includes(event.key.toLowerCase()))
        )
          return;
        event.preventDefault();
        const physical = event.code || event.key;
        const keyCode = heldKeys.current.get(physical);
        if (keyCode === undefined) return;
        heldKeys.current.delete(physical);
        sendInput.current({ type: "keyUp", keyCode, modifiers: modifiers(event) });
      }}
    >
      {frame === undefined ? null : (
        <img
          key={`${frame.presentationId}:${frame.sequence}`}
          ref={image}
          alt="Browser page image"
          draggable={false}
          src={frame.dataUrl}
          onLoad={() => {
            if (currentPresentation.current === frame.presentationId)
              displayed.current = frame.sequence;
          }}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      )}
      {failed ? (
        <OctantButton onClick={() => setAttempt((value) => value + 1)}>
          Retry Browser presentation
        </OctantButton>
      ) : null}
    </div>
  );
}
