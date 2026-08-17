import {
  parseKeybindingOverrides,
  resolveKeybindings,
  type OctantKeybindingActionId,
  type OctantKeybindings,
} from "@octant/domain";
import { useCallback, useMemo, useSyncExternalStore } from "react";

export const KEYBINDINGS_STORAGE_KEY = "octant.keybindings.v1";

/**
 * The user's chord overrides for this client.
 *
 * Deliberately per-client and deliberately local: a keybinding decides which
 * panel a key opens on the keyboard in front of the user, and nothing it opens
 * can reach an effect the server has not already authorized. Storing it here
 * keeps a preference about one keyboard out of the authoritative journal.
 */
export interface KeybindingStore {
  readonly getSnapshot: () => string;
  readonly write: (document: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Reading the property is itself the risk: a browser with site data blocked
 * throws `SecurityError` from the `localStorage` getter rather than from any
 * later call, so a default argument that names it would fail before this
 * store's own refusal handling could hold anything in memory.
 */
function defaultKeybindingStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function createKeybindingStore(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultKeybindingStorage(),
): KeybindingStore {
  const listeners = new Set<() => void>();
  // Held only while storage refuses the document. Reading through otherwise is
  // what keeps the snapshot a plain string — an unchanged document compares
  // equal and `useSyncExternalStore` stays quiet — and what picks up a document
  // written before this store existed.
  let unpersisted: string | undefined;
  function read(): string {
    if (unpersisted !== undefined) return unpersisted;
    if (storage === undefined) return "";
    try {
      return storage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  }

  return {
    getSnapshot: read,
    write: (document) => {
      try {
        if (storage === undefined) throw new Error("No storage.");
        storage.setItem(KEYBINDINGS_STORAGE_KEY, document);
        unpersisted = undefined;
      } catch {
        // Persistence is best-effort, but the chord still has to take effect
        // for this sitting: without the document in hand the next read would
        // return the old one and the change would appear not to have happened.
        unpersisted = document;
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const defaultStore = createKeybindingStore();

export interface KeybindingController {
  /** The effective chords, plus whatever could not be applied. */
  readonly keybindings: OctantKeybindings;
  /** The JSON document as the user last saved it. */
  readonly document: string;
  /** Why the saved document could not be read, when it could not be. */
  readonly documentError?: string;
  /** Replace the whole document. Rejects malformed JSON without saving it. */
  readonly saveDocument: (document: string) => string | undefined;
  /** Bind one action, leaving the rest of the document alone. */
  readonly bind: (actionId: OctantKeybindingActionId, chord: string) => void;
  /** Drop one action's override, returning it to its default. */
  readonly reset: (actionId: OctantKeybindingActionId) => void;
  readonly resetAll: () => void;
}

export function useKeybindings(store: KeybindingStore = defaultStore): KeybindingController {
  const document = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const parsed = useMemo(() => parseKeybindingOverrides(document), [document]);
  const keybindings = useMemo(
    () => resolveKeybindings(parsed.status === "ok" ? parsed.overrides : {}),
    [parsed],
  );

  const saveDocument = useCallback(
    (next: string): string | undefined => {
      const candidate = parseKeybindingOverrides(next);
      if (candidate.status !== "ok") return candidate.reason;
      store.write(next);
      return undefined;
    },
    [store],
  );

  const writeOverrides = useCallback(
    (overrides: Record<string, string>) => {
      store.write(
        Object.keys(overrides).length === 0 ? "" : `${JSON.stringify(overrides, null, 2)}\n`,
      );
    },
    [store],
  );

  const bind = useCallback(
    (actionId: OctantKeybindingActionId, chord: string) => {
      const current = parsed.status === "ok" ? parsed.overrides : {};
      writeOverrides({ ...current, [actionId]: chord });
    },
    [parsed, writeOverrides],
  );

  const reset = useCallback(
    (actionId: OctantKeybindingActionId) => {
      const current = parsed.status === "ok" ? parsed.overrides : {};
      const { [actionId]: _removed, ...rest } = current;
      writeOverrides(rest);
    },
    [parsed, writeOverrides],
  );

  const resetAll = useCallback(() => store.write(""), [store]);

  return {
    keybindings,
    document,
    ...(parsed.status === "ok" ? {} : { documentError: parsed.reason }),
    saveDocument,
    bind,
    reset,
    resetAll,
  };
}
