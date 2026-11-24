import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef, type RefObject } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

/**
 * A press held at least this long is hold-to-talk: letting go stops the clip.
 * A shorter press is a tap, and the next press stops it.
 */
export const HOLD_TO_TALK_MS = 300;

/**
 * Composers whose microphone is recording right now. Only one dictation runs
 * at a time, so while any is recording the shortcut belongs to it and a second
 * composer that has focus does not start its own.
 */
const recordingComposers = new Set<object>();

/** Modifier keys whose release ends a hold, since some keyboards never report the letter's. */
const MODIFIER_KEYS = new Set(["meta", "control", "alt", "shift"]);

export interface DictationShortcutTarget {
  /** Whether this composer may dictate now: transcription ready and the control enabled. */
  readonly enabled: boolean;
  readonly recording: boolean;
  /** An element inside the composer; the shortcut acts only when its composer has focus. */
  readonly anchor: RefObject<HTMLElement | null>;
  readonly start: () => void;
  readonly stop: () => void;
}

/**
 * The Dictate chord for one composer's microphone. A tap starts dictation and
 * the next tap stops it; holding the chord records until it is let go. It acts
 * on the composer whose text field has focus, never sends the message, and
 * does nothing while transcription is not ready.
 */
export function useDictationShortcut(target: DictationShortcutTarget): void {
  const { keybindings } = useKeybindings();
  const latest = useRef(target);
  latest.current = target;
  const identity = useRef({});

  useEffect(() => {
    const self = identity.current;
    if (target.recording) recordingComposers.add(self);
    else recordingComposers.delete(self);
    return () => {
      recordingComposers.delete(self);
    };
  }, [target.recording]);

  useEffect(() => {
    let press: { readonly at: number; readonly key: string; readonly started: boolean } | undefined;

    function onKeyDown(event: KeyboardEvent) {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "dictate") return;
      const current = latest.current;
      if (!current.enabled) return;
      if (current.recording) {
        event.preventDefault();
        if (event.repeat || press !== undefined) return;
        press = { at: Date.now(), key: event.key.toLowerCase(), started: false };
        current.stop();
        return;
      }
      if (recordingComposers.size > 0 || !composerHasFocus(current.anchor.current)) return;
      event.preventDefault();
      if (event.repeat) return;
      press = { at: Date.now(), key: event.key.toLowerCase(), started: true };
      current.start();
    }

    function onKeyUp(event: KeyboardEvent) {
      if (press === undefined) return;
      const key = event.key.toLowerCase();
      if (key !== press.key && !MODIFIER_KEYS.has(key)) return;
      const held = Date.now() - press.at;
      const startedHere = press.started;
      press = undefined;
      if (startedHere && held >= HOLD_TO_TALK_MS && latest.current.recording) {
        latest.current.stop();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [keybindings]);
}

/**
 * Whether focus is inside the composer that holds `anchor`. The composer is
 * the nearest ancestor that also holds a text field, so the microphone needs
 * no knowledge of which composer it sits in.
 */
function composerHasFocus(anchor: HTMLElement | null): boolean {
  const focused = document.activeElement;
  if (anchor === null || focused === null) return false;
  let node: HTMLElement | null = anchor.parentElement;
  while (node !== null) {
    if (node.querySelector("textarea, [contenteditable='true'], input[type='text']") !== null) {
      return node.contains(focused);
    }
    node = node.parentElement;
  }
  return false;
}
