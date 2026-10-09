import { useCallback, useEffect, useRef } from "react";

/**
 * What a person does to a device, in the device's own pixels. The iOS
 * Simulator and the Android emulator take the same four kinds; each pane
 * names the device it is for when it hands the intent on.
 */
export type DeviceInputIntent =
  | { readonly kind: "tap"; readonly point: { readonly x: number; readonly y: number } }
  | {
      readonly kind: "swipe";
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
      readonly durationMs: number;
    }
  | { readonly kind: "type-text"; readonly text: string }
  | { readonly kind: "key-press"; readonly key: string };

/** Adds one intent to the device's queue; `typing` holds it for the typing pause. */
export type EnqueueDeviceInput = (intent: DeviceInputIntent, typing: boolean) => void;

/** Typing is sent as one text once the keys stop for this long. */
const TYPING_PAUSE_MS = 350;
/** The longest text one typed-text request may carry; the host refuses more. */
const LONGEST_TYPED_TEXT = 4_096;
/** An input that has not made the pane busy by now never will; stop waiting for it. */
const UNANSWERED_INPUT_MS = 1_000;

/**
 * Sends what a person does to a device one action at a time, in the order they
 * did it. The host runs one device action at a time; what happens meanwhile
 * — more typing, a tap right after a swipe, Home clicked before the typing
 * pause has passed — waits here instead of being lost or overtaking.
 */
export function useOrderedDeviceInput(options: {
  /** The device the waiting input is for. */
  readonly owner: string;
  readonly busy: boolean;
  readonly onInput?: (intent: DeviceInputIntent) => void;
}) {
  const { busy, onInput, owner } = options;
  // The host runs one device action at a time. What a person does meanwhile
  // is kept in order and sent as each action finishes, so fast typing and a tap
  // right after a swipe are not lost to a disabled control.
  const waitingRef = useRef<DeviceInputIntent[]>([]);
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
      const spaces: DeviceInputIntent[] = [...next.text]
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

  // Waiting input and its timers belong to one device. When the pane moves
  // to another they are dropped, so nothing typed on one device is sent to the
  // next. React runs this before the effect above sends for the new device.
  useEffect(
    () => () => {
      if (typingRef.current !== undefined) clearTimeout(typingRef.current);
      if (unansweredRef.current !== undefined) clearTimeout(unansweredRef.current);
      typingRef.current = undefined;
      unansweredRef.current = undefined;
      waitingRef.current = [];
      sentRef.current = false;
    },
    [owner],
  );

  const enqueue: EnqueueDeviceInput = (intent, typing) => {
    const waiting = waitingRef.current;
    const last = waiting.at(-1);
    // Typing joins the text before it only while that typing's pause is still
    // running. Once the pause has passed the text is whole, even if it has to
    // wait for a running action: typing through a long build otherwise grew one
    // request past the longest text the host accepts, and all of it was refused.
    if (
      intent.kind === "type-text" &&
      last?.kind === "type-text" &&
      typingRef.current !== undefined &&
      last.text.length + intent.text.length <= LONGEST_TYPED_TEXT
    ) {
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
