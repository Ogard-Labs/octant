import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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

export interface ShellResizeHandleProps {
  readonly accessibleName: string;
  readonly className?: string;
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
  const activePointer = useRef<
    | {
        readonly pointerId: number;
        readonly startValue: number;
        readonly startPoint: number;
        lastValue: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const [resizing, setResizing] = useState(false);

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

  function pointerValue(event: ReactPointerEvent<HTMLElement>): number | undefined {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return undefined;
    const currentPoint = verticalResize(props.edge) ? event.clientY : event.clientX;
    const growsWithPointer = props.edge === "trailing" || props.edge === "bottom";
    const delta = growsWithPointer
      ? currentPoint - pointer.startPoint
      : pointer.startPoint - currentPoint;
    if (delta === 0 && !pointer.moved) return undefined;
    const value = clamp(pointer.startValue + delta, props.minimum, props.maximum);
    pointer.moved = true;
    pointer.lastValue = value;
    props.onPreview(value);
    return value;
  }

  function cancelPointerResize(): void {
    setResizing(false);
    cancelActivePointer(activePointer, props);
  }

  function finishPointerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return;
    const value = pointerValue(event) ?? pointer.lastValue;
    activePointer.current = undefined;
    setResizing(false);
    if (!pointer.moved) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    props.onCommit(value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
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
        aria-valuemin={props.minimum}
        aria-valuenow={props.value}
        aria-valuetext={`${props.value} px`}
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
            lastValue: props.value,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={pointerValue}
        onPointerUp={finishPointerResize}
        role="separator"
        tabIndex={0}
      />
      {resizing ? <ResizeDragShield axis={verticalResize(props.edge) ? "row" : "column"} /> : null}
    </>
  );
}

function cancelActivePointer(
  activePointer: React.RefObject<
    | {
        readonly startValue: number;
        readonly moved: boolean;
      }
    | undefined
  >,
  handlers: Pick<ShellResizeHandleProps, "onCancel" | "onPreview">,
): void {
  const pointer = activePointer.current;
  if (pointer === undefined) return;
  activePointer.current = undefined;
  if (!pointer.moved) return;
  handlers.onPreview(pointer.startValue);
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
