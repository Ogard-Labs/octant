import { createContext, useCallback, useContext, useRef, useState } from "react";

interface NewTaskDrafts {
  readonly read: (scope: string) => string;
  readonly write: (scope: string, text: string) => void;
  readonly readImages: (scope: string) => ReadonlyArray<File>;
  readonly writeImages: (scope: string, files: ReadonlyArray<File>) => void;
}

export function createNewTaskDrafts(): NewTaskDrafts {
  const drafts = new Map<string, string>();
  const images = new Map<string, ReadonlyArray<File>>();
  return {
    read: (scope) => drafts.get(scope) ?? "",
    write: (scope, text) => {
      if (text.length === 0) drafts.delete(scope);
      else drafts.set(scope, text);
    },
    readImages: (scope) => images.get(scope) ?? [],
    writeImages: (scope, files) => {
      if (files.length === 0) images.delete(scope);
      else images.set(scope, files);
    },
  };
}

export const NewTaskDraftsContext = createContext<NewTaskDrafts | undefined>(undefined);
export const NewTaskDraftScopeContext = createContext<string | undefined>(undefined);

/**
 * Keep a pane's unsent text while navigation temporarily unmounts its composer.
 *
 * Writes go to the store in the setter, not an effect. Create can open the
 * new thread and unmount this composer before React would flush a deferred
 * write, and a later remount would otherwise restore the submitted prompt.
 */
export function useNewTaskPrompt() {
  const drafts = useContext(NewTaskDraftsContext);
  const scope = useContext(NewTaskDraftScopeContext);
  const [prompt, setPromptState] = useState(() =>
    scope === undefined ? "" : (drafts?.read(scope) ?? ""),
  );
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const setPrompt = useCallback(
    (update: string | ((current: string) => string)) => {
      const next = typeof update === "function" ? update(promptRef.current) : update;
      promptRef.current = next;
      if (scope !== undefined && drafts !== undefined) {
        drafts.write(scope, next);
      }
      setPromptState(next);
    },
    [drafts, scope],
  );
  return [prompt, setPrompt] as const;
}
