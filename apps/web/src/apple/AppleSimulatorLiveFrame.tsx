import type { AppleSimulatorLiveFrame } from "@octant/domain";
import { canOfferAppleSimulatorFrameInput } from "@octant/domain";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { gestureFrom, keyIntentFor, type PointerSample } from "./simulatorGestures";
import type { AppleSimulatorLiveScreen } from "./useAppleSimulatorLiveScreen";

export type AppleSimulatorFrameInputIntent =
  | { readonly kind: "tap"; readonly point: { readonly x: number; readonly y: number } }
  | {
      readonly kind: "swipe";
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
      readonly durationMs: number;
    }
  | { readonly kind: "type-text"; readonly text: string }
  | { readonly kind: "key-press"; readonly key: string };

export interface AppleSimulatorLiveFrameProps {
  readonly frame: AppleSimulatorLiveFrame;
  readonly screenUrl?: string;
  /**
   * The Simulator's screen as it changes. When the host streams one it replaces
   * the captured still; without one the still is what the frame shows.
   */
  readonly liveScreen?: AppleSimulatorLiveScreen;
  /**
   * When true and the frame is live, tap/type/key controls are offered. Remote
   * and headless clients leave this false so the surface stays read-only.
   */
  readonly inputEnabled?: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy?: boolean;
}

export function AppleSimulatorLiveFrameView(props: AppleSimulatorLiveFrameProps) {
  const { frame } = props;
  const liveScreen =
    frame.status === "live" && frame.screen.kind === "screenshot"
      ? frame.screen.reference
      : undefined;
  const staleScreen =
    frame.status === "stale-after-restart" ? frame.lastScreen?.reference : undefined;
  const evidence = liveScreen ?? staleScreen;
  const offerInput =
    props.inputEnabled === true &&
    props.onInput !== undefined &&
    canOfferAppleSimulatorFrameInput(frame);
  const streamed =
    frame.status === "live" && props.liveScreen?.status === "live" ? props.liveScreen : undefined;
  return (
    <figure
      aria-label="iOS Simulator live frame"
      className={`apple-simulator-frame apple-simulator-frame--${frame.status}`}
      data-status={frame.status}
    >
      <figcaption>{frame.title}</figcaption>
      {frame.status === "live" && streamed !== undefined ? (
        <StreamedDevice
          // A device's waiting input, pending press and typing timer belong to
          // one Simulator. When the frame moves to another they are dropped with
          // the component, so nothing typed on one device is sent to the next.
          key={String(frame.simulatorId)}
          attach={streamed.attach}
          busy={props.busy === true}
          name={frame.name}
          offerInput={offerInput}
          {...(props.onInput === undefined ? {} : { onInput: props.onInput })}
          screen={streamed.screen}
        />
      ) : frame.status === "live" && props.screenUrl !== undefined ? (
        <LiveScreen
          busy={props.busy === true}
          name={frame.name}
          offerInput={offerInput}
          {...(props.onInput === undefined ? {} : { onInput: props.onInput })}
          screenUrl={props.screenUrl}
        />
      ) : frame.status === "live" && frame.screen.kind === "screenshot" ? (
        <p>The destination is live. The captured screen is not available in this frame.</p>
      ) : (
        <p>{frame.message}</p>
      )}
      {evidence === undefined ? null : (
        <p>
          Evidence <code>{evidence}</code>
        </p>
      )}
      {offerInput && streamed === undefined ? (
        <FrameInputControls busy={props.busy === true} onInput={props.onInput!} />
      ) : null}
    </figure>
  );
}

function LiveScreen(props: {
  readonly name: string;
  readonly screenUrl: string;
  readonly offerInput: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  return (
    // The screen is a coordinate hit region: taps translate to live-frame
    // image pixels, so the Octant button recipe (fixed height, padding)
    // cannot host it without distorting the mapped geometry.
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-label={
        props.offerInput
          ? `Tap on ${props.name} Simulator screen`
          : `${props.name} Simulator screen`
      }
      className="apple-simulator-frame__screen"
      disabled={!props.offerInput || props.busy || props.onInput === undefined}
      onClick={(event) => {
        if (!props.offerInput || props.onInput === undefined || props.busy) return;
        const image = imageRef.current;
        if (image === null) return;
        const rect = image.getBoundingClientRect();
        // AppleSimulatorPoint is the screenshot's own pixel space, and the
        // rendered image is CSS-scaled to the pane width, so a tap must be
        // rescaled from rendered pixels to naturalWidth/naturalHeight. An
        // undecoded image reports 0×0 natural size; drop the tap rather than
        // sending a point the host adapter would map onto nothing.
        if (rect.width <= 0 || rect.height <= 0) return;
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
        const x = ((event.clientX - rect.left) / rect.width) * image.naturalWidth;
        const y = ((event.clientY - rect.top) / rect.height) * image.naturalHeight;
        props.onInput({
          kind: "tap",
          point: { x: Math.round(x), y: Math.round(y) },
        });
      }}
      type="button"
    >
      <img alt={`${props.name} screen`} draggable={false} ref={imageRef} src={props.screenUrl} />
    </button>
  );
}

/** Typing is sent as one text once the keys stop for this long. */
const TYPING_PAUSE_MS = 350;
/** An input that has not made the pane busy by now never will; stop waiting for it. */
const UNANSWERED_INPUT_MS = 1_000;

/**
 * Sends what a person does to a device one action at a time, in the order they
 * did it. The host runs one Simulator action at a time; what happens meanwhile
 * — more typing, a tap right after a swipe, Home clicked before the typing
 * pause has passed — waits here instead of being lost or overtaking.
 */
function useOrderedSimulatorInput(options: {
  readonly busy: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
}) {
  const { busy, onInput } = options;
  // The host runs one Simulator action at a time. What a person does meanwhile
  // is kept in order and sent as each action finishes, so fast typing and a tap
  // right after a swipe are not lost to a disabled control.
  const waitingRef = useRef<AppleSimulatorFrameInputIntent[]>([]);
  const sentRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const unansweredRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const sendNext = useCallback(() => {
    if (onInput === undefined || busy || sentRef.current) return;
    let next = waitingRef.current.shift();
    // Text that is only blank is not a typed-text request the host accepts —
    // blank text is refused there on purpose. An ordinary space is still a key
    // a person pressed, so it goes as the Space key, one press at a time. Any
    // other blank (a non-breaking space from Option-Space, say) has no key
    // here; it is dropped and the next waiting intent is taken in its place,
    // or what was queued behind it would wait with nothing left to wake it.
    while (next !== undefined && next.kind === "type-text" && next.text.trim().length === 0) {
      const spaces: AppleSimulatorFrameInputIntent[] = [...next.text]
        .filter((character) => character === " ")
        .map(() => ({ kind: "key-press", key: "space" }));
      const [first, ...rest] = spaces;
      if (first !== undefined) {
        waitingRef.current.unshift(...rest);
        next = first;
        break;
      }
      next = waitingRef.current.shift();
    }
    if (next === undefined) return;
    // Until `busy` is seen to rise and fall, nothing else goes out. An input
    // the pane refused without ever going busy must not hold the rest forever.
    sentRef.current = true;
    if (unansweredRef.current !== undefined) clearTimeout(unansweredRef.current);
    unansweredRef.current = setTimeout(() => {
      unansweredRef.current = undefined;
      if (busyRef.current) return;
      sentRef.current = false;
      sendNextRef.current();
    }, UNANSWERED_INPUT_MS);
    onInput(next);
  }, [busy, onInput]);
  const sendNextRef = useRef(sendNext);
  sendNextRef.current = sendNext;

  useEffect(() => {
    if (busy) return;
    sentRef.current = false;
    if (typingRef.current === undefined) sendNext();
  }, [busy, sendNext]);

  useEffect(
    () => () => {
      if (typingRef.current !== undefined) clearTimeout(typingRef.current);
      if (unansweredRef.current !== undefined) clearTimeout(unansweredRef.current);
    },
    [],
  );

  const enqueue = (intent: AppleSimulatorFrameInputIntent, typing: boolean) => {
    const waiting = waitingRef.current;
    const last = waiting.at(-1);
    if (intent.kind === "type-text" && last?.kind === "type-text") {
      waiting[waiting.length - 1] = { kind: "type-text", text: last.text + intent.text };
    } else {
      waiting.push(intent);
    }
    if (typingRef.current !== undefined) clearTimeout(typingRef.current);
    typingRef.current = undefined;
    if (typing) {
      typingRef.current = setTimeout(() => {
        typingRef.current = undefined;
        // Through the ref: the action that was running when the key was typed
        // may be over by now, and this closure still believes it is busy.
        sendNextRef.current();
      }, TYPING_PAUSE_MS);
      return;
    }
    sendNext();
  };

  return enqueue;
}

function StreamedDevice(props: {
  readonly name: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly attach: (canvas: HTMLCanvasElement | null) => void;
  readonly offerInput: boolean;
  readonly onInput?: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  const enqueue = useOrderedSimulatorInput({
    busy: props.busy,
    ...(props.onInput === undefined ? {} : { onInput: props.onInput }),
  });
  const active = props.offerInput && props.onInput !== undefined;
  return (
    <>
      <StreamedScreen
        active={active}
        attach={props.attach}
        enqueue={enqueue}
        name={props.name}
        screen={props.screen}
      />
      {active ? (
        // Never disabled for being busy: the buttons wait their turn in the
        // same queue as the screen, behind whatever was typed before them.
        <FrameInputControls busy={false} onInput={(intent) => enqueue(intent, false)} />
      ) : null}
    </>
  );
}

function StreamedScreen(props: {
  readonly name: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly attach: (canvas: HTMLCanvasElement | null) => void;
  readonly active: boolean;
  readonly enqueue: (intent: AppleSimulatorFrameInputIntent, typing: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pressRef = useRef<(PointerSample & { readonly pointerId: number }) | undefined>(undefined);
  const { active, attach, enqueue } = props;
  return (
    // The same coordinate hit region as the captured still: the recipe's fixed
    // height and padding would distort the mapped geometry. It is not disabled
    // while an action runs — a disabled control drops focus and with it the
    // keys being typed.
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-label={
        active ? `Tap on ${props.name} Simulator screen` : `${props.name} Simulator screen`
      }
      className="apple-simulator-frame__screen"
      disabled={!active}
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
        // should reach the Simulator as a tap.
        if (event.button !== 0 || !event.isPrimary) return;
        pressRef.current = {
          x: event.clientX,
          y: event.clientY,
          atMs: event.timeStamp,
          pointerId: event.pointerId,
        };
        // Keeps the release coming here when a drag runs off the screen.
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerUp={(event) => {
        const down = pressRef.current;
        // Another finger lifting is not the end of this press.
        if (down === undefined || down.pointerId !== event.pointerId) return;
        pressRef.current = undefined;
        const canvas = canvasRef.current;
        if (!active || down === undefined || canvas === null) return;
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
        aria-label={`${props.name} live screen`}
        ref={(canvas) => {
          canvasRef.current = canvas;
          attach(canvas);
        }}
        role="img"
      />
    </button>
  );
}

function FrameInputControls(props: {
  readonly onInput: (intent: AppleSimulatorFrameInputIntent) => void;
  readonly busy: boolean;
}) {
  const textId = useId();
  const [text, setText] = useState("");
  return (
    <div className="apple-simulator-frame__input" role="group" aria-label="Simulator input">
      <label className="apple-simulator-frame__type" htmlFor={textId}>
        Type into Simulator
        <OctantInput
          autoComplete="off"
          disabled={props.busy}
          id={textId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || props.busy) return;
            event.preventDefault();
            if (text.trim().length === 0) return;
            props.onInput({ kind: "type-text", text });
            setText("");
          }}
          placeholder="Text to type"
          type="text"
          value={text}
        />
      </label>
      <div className="apple-simulator-frame__keys">
        <OctantButton
          disabled={props.busy || text.trim().length === 0}
          onClick={() => {
            if (text.trim().length === 0) return;
            props.onInput({ kind: "type-text", text });
            setText("");
          }}
          type="button"
          variant="secondary"
        >
          Type
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "return" })}
          type="button"
          variant="secondary"
        >
          Return
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "escape" })}
          type="button"
          variant="secondary"
        >
          Escape
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "home" })}
          type="button"
          variant="secondary"
        >
          Home
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => props.onInput({ kind: "key-press", key: "lock" })}
          type="button"
          variant="secondary"
        >
          Lock
        </OctantButton>
      </div>
    </div>
  );
}
