import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

export interface NewTaskDrafts {
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

function discardNewTaskDraftScope(drafts: NewTaskDrafts, scope: string): void {
  drafts.write(scope, "");
  drafts.writeImages(scope, []);
}

/**
 * Drop a pane's persisted new-task text and images after that pane is
 * permanently closed. Settings unmounts leave the store alone so the same
 * draft comes back; a later default pane can reuse this pane id.
 */
export function discardNewTaskDraftForPane(
  drafts: NewTaskDrafts | undefined,
  mode: "chat" | "work" | "code",
  paneId: string,
): void {
  if (drafts === undefined) return;
  discardNewTaskDraftScope(drafts, `${mode}:${paneId}`);
  if (mode === "chat") discardNewTaskDraftScope(drafts, `chat-welcome:${paneId}`);
}

/** Drop a Chat or Work Project overview draft after that surface is closed. */
export function discardNewTaskDraftForOverview(
  drafts: NewTaskDrafts | undefined,
  mode: "chat" | "work",
  projectId: string,
): void {
  if (drafts === undefined) return;
  discardNewTaskDraftScope(drafts, `${mode}-overview:${projectId}`);
}

export interface ProjectOverviewDraftRef {
  readonly mode: "chat" | "work";
  readonly projectId: string;
}

/**
 * Overview drafts to drop after a committed workspace update. A Project that
 * is still open in any pane keeps its draft. Settings remounts start from an
 * empty previous list and therefore keep every current overview. An optimistic
 * preview reuses the committed version, so a refused open or close can roll
 * the Project back without this treating the preview as a permanent drop.
 */
export function projectOverviewDraftsToDiscard(
  previous: ReadonlyArray<ProjectOverviewDraftRef>,
  next: ReadonlyArray<ProjectOverviewDraftRef>,
  previousCommit?: string | number,
  nextCommit?: string | number,
): ReadonlyArray<ProjectOverviewDraftRef> {
  if (
    previousCommit === undefined ||
    nextCommit === undefined ||
    String(previousCommit) === String(nextCommit)
  ) {
    return [];
  }
  const remaining = new Set(next.map((surface) => `${surface.mode}:${surface.projectId}`));
  const dropped: ProjectOverviewDraftRef[] = [];
  const seen = new Set<string>();
  for (const surface of previous) {
    const key = `${surface.mode}:${surface.projectId}`;
    if (remaining.has(key) || seen.has(key)) continue;
    seen.add(key);
    dropped.push(surface);
  }
  return dropped;
}

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
