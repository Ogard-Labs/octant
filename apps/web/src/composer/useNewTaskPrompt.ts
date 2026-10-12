import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

interface NewTaskDrafts {
  readonly read: (scope: string) => string;
  readonly write: (scope: string, text: string) => void;
  readonly readImages: (scope: string) => ReadonlyArray<File>;
  readonly writeImages: (scope: string, files: ReadonlyArray<File>) => void;
  readonly subscribe: (onStoreChange: () => void) => () => void;
}

export function createNewTaskDrafts(): NewTaskDrafts {
  const drafts = new Map<string, string>();
  const images = new Map<string, ReadonlyArray<File>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: (scope) => drafts.get(scope) ?? "",
    write: (scope, text) => {
      const current = drafts.get(scope) ?? "";
      if (text === current) return;
      if (text.length === 0) drafts.delete(scope);
      else drafts.set(scope, text);
      notify();
    },
    readImages: (scope) => images.get(scope) ?? [],
    writeImages: (scope, files) => {
      if (files.length === 0) images.delete(scope);
      else images.set(scope, files);
    },
    subscribe: (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
  };
}

export const NewTaskDraftsContext = createContext<NewTaskDrafts | undefined>(undefined);
export const NewTaskDraftScopeContext = createContext<string | undefined>(undefined);

const emptySubscribe = () => () => {};

/**
 * Keep a pane's unsent text while navigation temporarily unmounts its composer.
 *
 * The shared map is the source of truth when a scope is present: writes go
 * there immediately, and the live composer reloads when the scope changes or
 * the store is cleared. Create can open the new thread and unmount this
 * composer before React would flush a deferred write, and a later remount
 * would otherwise restore the submitted prompt.
 */
export function useNewTaskPrompt() {
  const drafts = useContext(NewTaskDraftsContext);
  const scope = useContext(NewTaskDraftScopeContext);
  const stored = useSyncExternalStore(drafts?.subscribe ?? emptySubscribe, () =>
    scope === undefined || drafts === undefined ? "" : drafts.read(scope),
  );
  const [local, setLocal] = useState("");
  const prompt = drafts !== undefined && scope !== undefined ? stored : local;
  const setPrompt = useCallback(
    (update: string | ((current: string) => string)) => {
      if (scope !== undefined && drafts !== undefined) {
        const current = drafts.read(scope);
        drafts.write(scope, typeof update === "function" ? update(current) : update);
        return;
      }
      setLocal((current) => (typeof update === "function" ? update(current) : update));
    },
    [drafts, scope],
  );
  return [prompt, setPrompt] as const;
}
