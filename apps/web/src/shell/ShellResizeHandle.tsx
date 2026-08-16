import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export interface ShellResizeHandleProps {
  readonly accessibleName: string;
  readonly className?: string;
  readonly edge: "leading" | "trailing";
  readonly maximum: number;
  readonly minimum: number;
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
        readonly startX: number;
        lastValue: number;
        moved: boolean;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    function handleWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || activePointer.current === undefined) return;
      event.preventDefault();
      cancelActivePointer(activePointer, latestProps.current.onPreview);
    }
    function handleWindowBlur(): void {
      cancelActivePointer(activePointer, latestProps.current.onPreview);
    }
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      cancelActivePointer(activePointer, latestProps.current.onPreview);
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  function pointerValue(event: ReactPointerEvent<HTMLElement>): number | undefined {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return undefined;
    const delta =
      props.edge === "trailing" ? event.clientX - pointer.startX : pointer.startX - event.clientX;
    if (delta === 0 && !pointer.moved) return undefined;
    const value = clamp(pointer.startValue + delta, props.minimum, props.maximum);
    pointer.moved = true;
    pointer.lastValue = value;
    props.onPreview(value);
    return value;
  }

  function cancelPointerResize(): void {
    cancelActivePointer(activePointer, props.onPreview);
  }

  function finishPointerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointer = activePointer.current;
    if (pointer === undefined || pointer.pointerId !== event.pointerId) return;
    const value = pointerValue(event) ?? pointer.lastValue;
    activePointer.current = undefined;
    if (!pointer.moved) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    props.onCommit(value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
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
    <div
      aria-label={props.accessibleName}
      aria-orientation="vertical"
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
          startX: event.clientX,
          lastValue: props.value,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={pointerValue}
      onPointerUp={finishPointerResize}
      role="separator"
      tabIndex={0}
    />
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
  onPreview: (value: number) => void,
): void {
  const pointer = activePointer.current;
  if (pointer === undefined) return;
  activePointer.current = undefined;
  if (pointer.moved) onPreview(pointer.startValue);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function keyboardDirection(key: string, edge: ShellResizeHandleProps["edge"]): -1 | 1 | undefined {
  if (key === "ArrowRight") return edge === "trailing" ? 1 : -1;
  if (key === "ArrowLeft") return edge === "trailing" ? -1 : 1;
  return undefined;
}
