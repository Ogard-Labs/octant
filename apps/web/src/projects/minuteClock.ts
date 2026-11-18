import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function currentMinute(): number {
  return Math.floor(Date.now() / MINUTE_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // One interval serves every row: a list of fifty threads would otherwise
    // run fifty timers to move a word that changes once a minute.
    timer = setInterval(() => {
      for (const notify of listeners) notify();
    }, MINUTE_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * The current time, read again once a minute, for rows that show a short age.
 * The minute only decides when to render; the value is the real time, so an
 * age never lags the minute it was drawn in.
 */
export function useMinuteClock(): number {
  useSyncExternalStore(subscribe, currentMinute, currentMinute);
  return Date.now();
}
