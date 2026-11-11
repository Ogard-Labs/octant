/** Local recovery only: drafts are never messages, journal entries or provider context. */
export interface EditorDraftStore {
  readonly read: (key: string) => string | undefined;
  readonly write: (key: string, value: string) => void;
  readonly clear: (key: string) => void;
  readonly error?: () => string | undefined;
}
export function createEditorDraftStore(
  scope: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): EditorDraftStore {
  const memory = new Map<string, string>();
  const unpersisted = new Set<string>();
  let failure: string | undefined;
  const prefix = `octant.editor-drafts.v1:${encodeURIComponent(scope)}:`;
  const keyFor = (key: string) => prefix + encodeURIComponent(key);
  const backing = () => {
    try {
      return storage ?? globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    read(key: string): string | undefined {
      if (unpersisted.has(key)) return memory.get(key);
      try {
        const value = backing()?.getItem(keyFor(key));
        if (value !== null && value !== undefined) {
          memory.set(key, value);
          return value;
        }
        memory.delete(key);
      } catch {
        failure = "Draft recovery is unavailable on this device.";
      }
      return memory.get(key);
    },
    write(key: string, value: string): void {
      memory.set(key, value);
      try {
        const target = backing();
        if (target === undefined) throw new Error("unavailable");
        target.setItem(keyFor(key), value);
        unpersisted.delete(key);
        failure = undefined;
      } catch {
        unpersisted.add(key);
        failure = "Your edits are held in this window only. Save before closing it.";
      }
    },
    clear(key: string): void {
      memory.delete(key);
      unpersisted.delete(key);
      try {
        backing()?.removeItem(keyFor(key));
        failure = undefined;
      } catch {
        failure = "The recovery copy could not be removed. It may return after restart.";
      }
    },
    error: () => failure,
  };
}
