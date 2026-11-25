import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

/**
 * Covers the window while a divider is dragged. A native Browser page sits
 * above the document and would swallow the pointer as the drag crosses it;
 * this shield matches the Browser overlay selector, so the page leaves the
 * window for the length of the drag.
 */
export function ResizeDragShield(props: { readonly axis: "column" | "row" }) {
  return createPortal(
    <div aria-hidden="true" className="shell-resize-shield" data-axis={props.axis} />,
    document.body,
  );
}

/**
 * How far past the minimum a drag must go before a collapsible panel hides,
 * and how far a hidden panel's edge must be pulled before it shows again. A
 * drag that only overshoots the minimum keeps the panel at its minimum.
 */
export const RESIZE_COLLAPSE_DISTANCE = 64;

export interface ShellResizeHandleProps {
  readonly accessibleName: string;
  readonly className?: string;
  /** Lets a drag hide the panel and pull it back out. A handle without it only resizes. */
  readonly collapse?: {
    readonly collapsed: boolean;
    readonly onCollapsedChange: (collapsed: boolean) => void;
  };
  readonly edge: "leading" | "trailing" | "top" | "bottom";
  readonly maximum: number;
  readonly minimum: number;
  /** Runs after a moved drag is abandoned and its starting value restored. */
  readonly onCancel?: () => void;
  readonly onCommit: (value: number) => void;
  readonly onPreview: (value: number) => void;
  readonly value: number;
}

export function ShellResizeHandle(props: ShellResizeHandleProps) {
  const latestProps = useRef(props);
  latestProps.current = props;
  const activePointer = useRef<ActivePointer | undefined>(undefined);
  const [resizing, setResizing] = useState(false);
  const collapsed = props.collapse?.collapsed === true;

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || activePointer.current === undefined) return;
      event.preventDefault();
      setResizing(false);
      cancelActivePointer(activePointer, latestProps.current);
    }
    function handleWindowBlur(): void {
      setResizing(false);
      cancelActivePointer(activePointer, latestProps.current);
    }
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      cancelActivePointer(activePointer, latestProps.current);
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // The toggle can hide or show the panel while its edge is held. The toggle
  // wins: the drag ends there, so its release saves no width and Escape undoes
  // nothing. A flip the drag made itself is already in the pointer's record.
  useLayoutEffect(() => {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.collapsed === collapsed) return;
    activePointer.current = undefined;
    setResizing(false);
    if (!pointer.moved) return;
    latestProps.current.onPreview(pointer.startValue);
    latestProps.current.onCancel?.();
  }, [collapsed]);

  function movePointer(event: ReactPointerEvent<HTMLElement>): void {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return;
    const currentPoint = verticalResize(props.edge) ? event.clientY : event.clientX;
    const growsWithPointer = props.edge === "trailing" || props.edge === "bottom";
    const delta = growsWithPointer
      ? currentPoint - pointer.startPoint
      : pointer.startPoint - currentPoint;
    if (delta === 0 && !pointer.moved) return;
    // Where the dragged edge asks to be, before the bounds apply. A hidden
    // panel's edge starts from nothing.
    const requested = (pointer.startCollapsed ? 0 : pointer.startValue) + delta;
    const hidden =
      props.collapse !== undefined &&
      requested <
        (pointer.startCollapsed
          ? RESIZE_COLLAPSE_DISTANCE
          : props.minimum - RESIZE_COLLAPSE_DISTANCE);
    const changed = hidden !== pointer.collapsed;
    // A short pull on a hidden panel's edge has changed nothing yet.
    if (hidden && !changed && !pointer.moved) return;
    pointer.moved = true;
    pointer.collapsed = hidden;
    // A hidden panel keeps the width the drag started with, so showing it
    // another way brings that width back.
    pointer.lastValue = hidden
      ? pointer.startValue
      : clamp(requested, props.minimum, props.maximum);
    if (!hidden || changed) props.onPreview(pointer.lastValue);
    if (changed) props.collapse?.onCollapsedChange(hidden);
  }

  function cancelPointerResize(): void {
    setResizing(false);
    cancelActivePointer(activePointer, props);
  }

  function finishPointerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return;
    movePointer(event);
    activePointer.current = undefined;
    setResizing(false);
    if (!pointer.moved) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!pointer.collapsed) props.onCommit(pointer.lastValue);
  }

  // The arrow that widens a panel shows a hidden one at the width it had;
  // Home and End show it at the bound they name.
  function handleCollapsedKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const bound =
      event.key === "Home" ? props.minimum : event.key === "End" ? props.maximum : undefined;
    const direction = keyboardDirection(event.key, props.edge);
    if (bound === undefined && direction === undefined) return;
    event.preventDefault();
    if (bound === undefined && direction !== 1) return;
    if (bound !== undefined && bound !== props.value) {
      props.onPreview(bound);
      props.onCommit(bound);
    }
    props.collapse?.onCollapsedChange(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (collapsed) {
      handleCollapsedKeyDown(event);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const value = event.key === "Home" ? props.minimum : props.maximum;
      if (value === props.value) return;
      props.onPreview(value);
      props.onCommit(value);
      return;
    }
    const direction = keyboardDirection(event.key, props.edge);
    if (direction === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 8;
    const value = clamp(props.value + direction * step, props.minimum, props.maximum);
    if (value === props.value) return;
    props.onPreview(value);
    props.onCommit(value);
  }

  return (
    <>
      <div
        aria-label={props.accessibleName}
        aria-orientation={verticalResize(props.edge) ? "horizontal" : "vertical"}
        aria-valuemax={props.maximum}
        aria-valuemin={collapsed ? 0 : props.minimum}
        aria-valuenow={collapsed ? 0 : props.value}
        aria-valuetext={collapsed ? "Hidden" : `${props.value} px`}
        className={props.className}
        data-edge={props.edge}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={cancelPointerResize}
        onPointerCancel={cancelPointerResize}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          activePointer.current = {
            pointerId: event.pointerId,
            startValue: props.value,
            startPoint: verticalResize(props.edge) ? event.clientY : event.clientX,
            startCollapsed: collapsed,
            collapsed,
            lastValue: props.value,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={movePointer}
        onPointerUp={finishPointerResize}
        role="separator"
        tabIndex={0}
      />
      {resizing ? <ResizeDragShield axis={verticalResize(props.edge) ? "row" : "column"} /> : null}
    </>
  );
}

interface ActivePointer {
  readonly pointerId: number;
  readonly startValue: number;
  readonly startPoint: number;
  readonly startCollapsed: boolean;
  collapsed: boolean;
  lastValue: number;
  moved: boolean;
}

function cancelActivePointer(
  activePointer: React.RefObject<ActivePointer | undefined>,
  handlers: Pick<ShellResizeHandleProps, "collapse" | "onCancel" | "onPreview">,
): void {
  const pointer = activePointer.current;
  if (pointer === undefined) return;
  activePointer.current = undefined;
  if (!pointer.moved) return;
  handlers.onPreview(pointer.startValue);
  if (pointer.collapsed !== pointer.startCollapsed) {
    handlers.collapse?.onCollapsedChange(pointer.startCollapsed);
  }
  handlers.onCancel?.();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function keyboardDirection(key: string, edge: ShellResizeHandleProps["edge"]): -1 | 1 | undefined {
  if (verticalResize(edge)) {
    if (key === "ArrowUp") return edge === "top" ? 1 : -1;
    if (key === "ArrowDown") return edge === "top" ? -1 : 1;
    return undefined;
  }
  if (key === "ArrowRight") return edge === "trailing" ? 1 : -1;
  if (key === "ArrowLeft") return edge === "trailing" ? -1 : 1;
  return undefined;
}

function verticalResize(edge: ShellResizeHandleProps["edge"]): boolean {
  return edge === "top" || edge === "bottom";
}
