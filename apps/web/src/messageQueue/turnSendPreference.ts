import { useSyncExternalStore } from "react";

/**
 * What a Work or Code message sent while a turn runs does by default on this
 * client: steer that turn where its runtime steers, or wait for the next turn
 * (maintainer decision D1, 2026-11-26). It is this client's own preference,
 * never the host's; the host only learns, per message, that one waits.
 */
export type TurnSendPreference = "steer" | "queue";

const STORAGE_KEY = "octant.composer.while-turn-runs.v1";
const listeners = new Set<() => void>();

export function readTurnSendPreference(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): TurnSendPreference {
  try {
    return storage?.getItem(STORAGE_KEY) === "queue" ? "queue" : "steer";
  } catch {
    return "steer";
  }
}

export function writeTurnSendPreference(
  preference: TurnSendPreference,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, preference);
  } catch {
    // A preference that cannot be kept lasts for this window only.
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
