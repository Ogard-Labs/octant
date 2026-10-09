import { useRef, type FocusEventHandler } from "react";
import { gestureFrom, keyIntentFor, type PointerSample } from "../apple/simulatorGestures";
import type { DeviceInputIntent, EnqueueDeviceInput } from "./deviceInput";

/**
 * A device's streamed screen as one control: press and release become a tap or
 * a swipe, and keys typed while it has focus go to the device.
 *
 * It is the drawn screen and nothing else, so a point is measured against the
 * picture. It is not disabled while an action runs — a disabled control drops
 * focus and with it the keys being typed.
 */
export function StreamedScreen(props: {
  readonly label: string;
  readonly pictureLabel: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly attach: (canvas: HTMLCanvasElement | null) => void;
  readonly active: boolean;
  readonly enqueue: EnqueueDeviceInput;
  readonly describedBy?: string;
  readonly onFocus?: FocusEventHandler<HTMLButtonElement>;
  readonly onBlur?: FocusEventHandler<HTMLButtonElement>;
  /** Where a press began on the drawn screen, in window coordinates. */
  readonly onPress?: (point: { readonly x: number; readonly y: number }) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pressRef = useRef<(PointerSample & { readonly pointerId: number }) | undefined>(undefined);
  const { active, attach, enqueue } = props;
  return (
    // The screen is a coordinate hit region: the button recipe's fixed height
    // and padding would distort the mapped geometry.
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-describedby={props.describedBy}
      aria-label={props.label}
      className="device-screen"
      disabled={!active}
      onBlur={props.onBlur}
      onFocus={props.onFocus}
      onKeyDown={(event) => {
        if (!active) return;
        const intent = keyIntentFor(event);
        if (intent === undefined) return;
        event.preventDefault();
        if (intent.kind === "text") enqueue({ kind: "type-text", text: intent.text }, true);
        else enqueue({ kind: "key-press", key: intent.key }, false);
      }}
      onPointerCancel={(event) => {
        if (pressRef.current?.pointerId === event.pointerId) pressRef.current = undefined;
      }}
      onPointerDown={(event) => {
        if (!active) return;
        // Only a primary press is a finger on the device. A right-click opens
        // a menu and a second touch point is part of something else; neither
        // should reach the device as a tap.
        if (event.button !== 0 || !event.isPrimary) return;
        pressRef.current = {
          x: event.clientX,
          y: event.clientY,
          atMs: event.timeStamp,
          pointerId: event.pointerId,
        };
        props.onPress?.({ x: event.clientX, y: event.clientY });
        // Keeps the release coming here when a drag runs off the screen.
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerUp={(event) => {
        const down = pressRef.current;
        // Another finger lifting is not the end of this press.
        if (down === undefined || down.pointerId !== event.pointerId) return;
        pressRef.current = undefined;
        const canvas = canvasRef.current;
        if (!active || canvas === null) return;
        const gesture = gestureFrom(
          down,
          { x: event.clientX, y: event.clientY, atMs: event.timeStamp },
          canvas.getBoundingClientRect(),
          props.screen,
        );
        if (gesture !== undefined) enqueue(gesture, false);
      }}
      type="button"
    >
      <canvas
        aria-label={props.pictureLabel}
        ref={(canvas) => {
          canvasRef.current = canvas;
          attach(canvas);
        }}
        role="img"
      />
    </button>
  );
}

/**
 * A captured still of the device's screen. A click on it is a tap at the same
 * place on the device; there is no drag or typing on a still.
 */
export function StillScreen(props: {
  readonly label: string;
  readonly pictureLabel: string;
  readonly url: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onTap?: (intent: Extract<DeviceInputIntent, { kind: "tap" }>) => void;
  readonly onPress?: (point: { readonly x: number; readonly y: number }) => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const usable = props.active && props.onTap !== undefined && props.disabled !== true;
  return (
    // The screen is a coordinate hit region: taps translate to image pixels,
    // so the button recipe (fixed height, padding) cannot host it without
    // distorting the mapped geometry.
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-label={props.label}
      className="device-screen"
      disabled={!usable}
      onClick={(event) => {
        if (!usable || props.onTap === undefined) return;
        const image = imageRef.current;
        if (image === null) return;
        const rect = image.getBoundingClientRect();
        // A point is in the screenshot's own pixel space, and the rendered
        // image is CSS-scaled to the pane, so a tap is rescaled from rendered
        // pixels to the natural size. An undecoded image reports 0×0 natural
        // size; drop the tap rather than sending a point the host adapter
        // would map onto nothing.
        if (rect.width <= 0 || rect.height <= 0) return;
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
        // The hit region can be wider than the drawn screen when the pane's
        // height binds. A click there is not on the device, so it is not a tap.
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          return;
        }
        props.onPress?.({ x: event.clientX, y: event.clientY });
        const x = ((event.clientX - rect.left) / rect.width) * image.naturalWidth;
        const y = ((event.clientY - rect.top) / rect.height) * image.naturalHeight;
        props.onTap({ kind: "tap", point: { x: Math.round(x), y: Math.round(y) } });
      }}
      type="button"
    >
      <img alt={props.pictureLabel} draggable={false} ref={imageRef} src={props.url} />
    </button>
  );
}
