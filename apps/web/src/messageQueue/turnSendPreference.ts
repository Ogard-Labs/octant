import { useSyncExternalStore } from "react";

/**
 * What a Work or Code message sent while a turn runs does by default on this
 * client: steer that turn where its runtime steers, or wait for the next turn
 * (thread-view.md, Message queue and Stop). It is this client's own preference,
 * never the host's; the host only learns, per message, that one waits.
 */
export type TurnSendPreference = "steer" | "queue";

const STORAGE_KEY = "octant.composer.while-turn-runs.v1";
const listeners = new Set<() => void>();
/** A choice the browser would not store: it lasts for this window only. */
let unsaved: TurnSendPreference | undefined;

// A browser that blocks site data throws on reading `localStorage` itself, so
// the store is looked up inside each `try`, never as a default argument.
function localStore(): Storage | undefined {
  return globalThis.localStorage;
}

export function readTurnSendPreference(storage?: Pick<Storage, "getItem">): TurnSendPreference {
  if (unsaved !== undefined) return unsaved;
  try {
    return (storage ?? localStore())?.getItem(STORAGE_KEY) === "queue" ? "queue" : "steer";
  } catch {
    return "steer";
  }
}

export function writeTurnSendPreference(
  preference: TurnSendPreference,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? localStore())?.setItem(STORAGE_KEY, preference);
    unsaved = undefined;
  } catch {
    unsaved = preference;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function useTurnSendPreference(): TurnSendPreference {
  return useSyncExternalStore(
    subscribe,
    () => readTurnSendPreference(),
    () => "steer",
  );
}

/** A message's timing: the default, or its opposite when ⌘↩ (Ctrl+↩) sent it. */
export function messageTiming(
  preference: TurnSendPreference,
  opposite: boolean,
): "next-turn" | undefined {
  return (preference === "queue") !== opposite ? "next-turn" : undefined;
}
