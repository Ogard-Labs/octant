import { Schema } from "effect";
import { createContext, useEffect, useMemo } from "react";

const offset = Schema.Number.pipe(Schema.between(0, 100_000_000));
const position = Schema.Int.pipe(Schema.between(1, 10_000_000));
const ViewState = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("editor"),
    lineNumber: position,
    column: position,
    scrollTop: offset,
    scrollLeft: offset,
  }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    path: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
    scrollTop: offset,
  }),
  Schema.Struct({
    kind: Schema.Literal("transcript"),
    offset,
    following: Schema.Boolean,
    firstKey: Schema.String.pipe(Schema.maxLength(1024)),
    width: offset,
  }),
);
export type WorkspaceViewState = typeof ViewState.Type;
export interface WorkspaceViewStore {
  readonly read: (key: string) => WorkspaceViewState | undefined;
  readonly write: (key: string, value: WorkspaceViewState) => void;
}
export const WorkspaceViewStateContext = createContext<WorkspaceViewStore | undefined>(undefined);
const Saved = Schema.Array(
  Schema.Struct({ key: Schema.String.pipe(Schema.maxLength(8192)), value: ViewState }),
).pipe(Schema.maxItems(64));
const MAX_BYTES = 128 * 1024;

/** Only bounded presentation references; host state and document contents never enter this store. */
export function createWorkspaceViewStore(namespace: string) {
  const key = `octant.workspace.views.v1:${namespace}`;
  const entries = new Map<string, WorkspaceViewState>();
  try {
    const saved = globalThis.localStorage.getItem(key);
    if (saved !== null && saved.length <= MAX_BYTES)
      for (const entry of Schema.decodeUnknownSync(Saved)(JSON.parse(saved)))
        entries.set(entry.key, entry.value);
  } catch {
    /* Unavailable or invalid local state is a fresh view. */
  }
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (pending !== undefined) clearTimeout(pending);
    pending = undefined;
    try {
      let saved = JSON.stringify([...entries].map(([key, value]) => ({ key, value })));
      while (saved.length > MAX_BYTES && entries.size > 0) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
        saved = JSON.stringify([...entries].map(([key, value]) => ({ key, value })));
      }
      globalThis.localStorage.setItem(key, saved);
    } catch {
      /* A full local store must not interrupt reading or navigation. */
    }
  };
  return {
    read: (key: string) => entries.get(key),
    write: (key: string, value: WorkspaceViewState) => {
      if (key.length > 8192) return;
      let valid: WorkspaceViewState;
      try {
        valid = Schema.decodeUnknownSync(ViewState)(value);
      } catch {
        return;
      }
      entries.delete(key);
      entries.set(key, valid);
      while (entries.size > 64) {
        const first = entries.keys().next().value;
        if (first === undefined) break;
        entries.delete(first);
      }
      if (pending === undefined) pending = setTimeout(flush, 150);
    },
    flush,
  };
}
export function useWorkspaceViewStore(
  namespace: string | undefined,
  scope: string,
): WorkspaceViewStore | undefined {
  const store = useMemo(
    () => (namespace === undefined ? undefined : createWorkspaceViewStore(namespace)),
    [namespace],
  );
  useEffect(() => {
    if (store === undefined) return;
    window.addEventListener("pagehide", store.flush);
    return () => {
      window.removeEventListener("pagehide", store.flush);
      store.flush();
    };
  }, [store]);
  return useMemo(
    () =>
      store === undefined
        ? undefined
        : {
            read: (key) => store.read(`${scope}:${key}`),
            write: (key, value) => store.write(`${scope}:${key}`, value),
          },
    [store, scope],
  );
}
