import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Above this length every reveal step re-parses a large Markdown document, so
// the steps come less often.
const LONG_ANSWER_LENGTH = 16_000;
const STEP_MS = 32;
const LONG_STEP_MS = 100;
// How much arrived text the reveal holds back, in arrival intervals, bounded so
// a slow provider adds no visible lag and a bursty one still has text to pace.
const MIN_BUFFER_MS = 50;
const MAX_BUFFER_MS = 400;
// Past this far behind the arrival (a reconnect, a large paste) the reveal
// jumps ahead rather than spend seconds catching up.
const SKIP_AHEAD_MS = 1_200;
// The finished answer drains over this long instead of snapping.
const DRAIN_MS = 100;
// A backlog beyond the buffer is closed over this long, so the speed-up is
// gentle.
const CATCH_UP_MS = 300;
// A word that ends within this many characters is revealed whole.
const WORD_REACH = 12;
const DEFAULT_RATE = 0.05;
const DEFAULT_INTERVAL_MS = 100;
const MAX_RATE = 0.5;
const SMOOTHING = 0.25;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

/**
 * Moves a reveal point to a place a reader would not notice: after a word that
 * ends a few characters on, and never between the halves of a surrogate pair.
 */
function settleOnWord(text: string, position: number, available: number): number {
  let end = Math.min(position, available);
  if (end <= 0 || end >= available) return end;
  if (!isWhitespace(text[end - 1]) && !isWhitespace(text[end])) {
    for (let reach = 1; reach <= WORD_REACH && end + reach < available; reach += 1) {
      // A word cut by the end of the text may still be growing, so only a word
      // followed by a boundary counts as ended.
      if (isWhitespace(text[end + reach])) {
        end += reach;
        break;
      }
    }
  }
  const unit = text.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff && end < available) end += 1;
  return end;
}

interface PaceState {
  rate: number;
  interval: number;
  lastArrival: number;
  lastLength: number;
  position: number;
  lastStep: number;
  lastFrame: number;
  drainBy: number | undefined;
}

function freshPace(length: number, now: number): PaceState {
  return {
    rate: DEFAULT_RATE,
    interval: DEFAULT_INTERVAL_MS,
    lastArrival: now,
    lastLength: length,
    position: length,
    lastStep: 0,
    lastFrame: now,
    drainBy: undefined,
  };
}

/**
 * The part of a streaming answer to show: text that arrives in bursts is
 * revealed at the pace it arrives, so it reads as steady typing.
 *
 * The first content, a replacement, text opened mid-stream and every answer
 * under reduced motion show whole. The finished answer drains within 100 ms.
 */
export function useEvenReveal(body: string, streaming: boolean): string {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    readReducedMotion,
    () => false,
  );
  const [shown, setShown] = useState(body);
  const shownRef = useRef(body);
  const bodyRef = useRef(body);
  const pace = useRef<PaceState | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  // True while the answer streams and until its drain has finished.
  const live = useRef(streaming);

  // A replacement or a first answer is current in this render, before the
  // effect has run.
  const immediate =
    reducedMotion || (!streaming && !live.current) || shown.length === 0 || !body.startsWith(shown);

  useEffect(() => {
    const now = performance.now();
    const state = (pace.current ??= freshPace(body.length, now));
    const cancel = () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
    const tick = () => {
      frame.current = undefined;
      const at = performance.now();
      const text = bodyRef.current;
      const available = text.length;
      const elapsed = Math.min(at - state.lastFrame, 100);
      state.lastFrame = at;
      const backlog = available - state.position;
      if (backlog <= 0) return;
      const bufferChars = Math.max(
        1,
        Math.min(Math.max(state.interval, MIN_BUFFER_MS), MAX_BUFFER_MS) * state.rate,
      );
      if (state.drainBy !== undefined) {
        const remaining = state.drainBy - at;
        state.position =
          remaining <= 0
            ? available
            : Math.min(
                available,
                state.position + (backlog * elapsed) / Math.max(remaining, elapsed),
              );
      } else if (backlog > state.rate * SKIP_AHEAD_MS) {
        state.position = available - bufferChars;
      } else {
        const speed =
          state.rate * Math.min(1, Math.max(0.25, backlog / bufferChars)) +
          Math.max(0, backlog - bufferChars) / CATCH_UP_MS;
        state.position = Math.min(available, state.position + speed * elapsed);
      }
      const target =
        state.position >= available
          ? available
          : settleOnWord(text, Math.floor(state.position), available);
      state.position = Math.max(state.position, target);
      const stepMs = available >= LONG_ANSWER_LENGTH ? LONG_STEP_MS : STEP_MS;
      if (
        target !== shownRef.current.length &&
        (target >= available || at - state.lastStep >= stepMs)
      ) {
        state.lastStep = at;
        const next = text.slice(0, target);
        shownRef.current = next;
        setShown(next);
      }
      if (state.position < available) frame.current = requestAnimationFrame(tick);
      else if (state.drainBy !== undefined) {
        state.drainBy = undefined;
        live.current = false;
      }
    };

    const previous = bodyRef.current;
    bodyRef.current = body;
    const wasLive = live.current;
    live.current = streaming || (wasLive && shownRef.current.length < body.length);
    const replaced =
      reducedMotion ||
      (!streaming && !wasLive) ||
      shownRef.current.length === 0 ||
      !body.startsWith(shownRef.current) ||
      body.length < previous.length;
    if (replaced) {
      cancel();
      pace.current = freshPace(body.length, now);
      shownRef.current = body;
      setShown(body);
      return;
    }
    if (body.length > state.lastLength) {
      const gap = Math.max(now - state.lastArrival, 10);
      const sample = Math.min((body.length - state.lastLength) / gap, MAX_RATE);
      state.rate = Math.max(0.005, state.rate + (sample - state.rate) * SMOOTHING);
      state.interval += (Math.min(gap, 2_000) - state.interval) * SMOOTHING;
      state.lastArrival = now;
      state.lastLength = body.length;
    }
    if (streaming) state.drainBy = undefined;
    else if (state.drainBy === undefined && shownRef.current.length < body.length) {
      state.drainBy = now + DRAIN_MS;
    }
    // A frame already waiting keeps its start, so a delta never costs the
    // reveal the time since the last frame.
    if (shownRef.current.length < body.length && frame.current === undefined) {
      state.lastFrame = now;
      frame.current = requestAnimationFrame(tick);
    }
  }, [body, streaming, reducedMotion]);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    },
    [],
  );

  return immediate ? body : shown;
}
