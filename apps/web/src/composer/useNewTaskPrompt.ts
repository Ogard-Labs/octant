import { createContext, useContext, useEffect, useState } from "react";

interface NewTaskDrafts {
  readonly read: (scope: string) => string;
  readonly write: (scope: string, text: string) => void;
}

export function createNewTaskDrafts(): NewTaskDrafts {
  const drafts = new Map<string, string>();
  return {
    read: (scope) => drafts.get(scope) ?? "",
    write: (scope, text) => {
      if (text.length === 0) drafts.delete(scope);
      else drafts.set(scope, text);
    },
  };
}

export const NewTaskDraftsContext = createContext<NewTaskDrafts | undefined>(undefined);
export const NewTaskDraftScopeContext = createContext<string | undefined>(undefined);

/** Keep a pane's unsent text while navigation temporarily unmounts its composer. */
export function useNewTaskPrompt() {
  const drafts = useContext(NewTaskDraftsContext);
  const scope = useContext(NewTaskDraftScopeContext);
  const [prompt, setPrompt] = useState(() =>
    scope === undefined ? "" : (drafts?.read(scope) ?? ""),
  );
  useEffect(() => {
    if (scope === undefined || drafts === undefined) return;
    drafts.write(scope, prompt);
  }, [drafts, scope, prompt]);
  return [prompt, setPrompt] as const;
}
