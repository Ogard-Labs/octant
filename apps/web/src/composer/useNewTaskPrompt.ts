import type { GithubIssueContextRequest, LinearIssueContextRequest } from "@octant/contracts";
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";

export type NewTaskCreateFromSelection =
  | {
      readonly kind: "github";
      readonly request: GithubIssueContextRequest;
      readonly label: string;
    }
  | {
      readonly kind: "linear";
      readonly request: LinearIssueContextRequest;
      readonly label: string;
    };

export interface NewTaskDrafts {
  readonly read: (scope: string) => string;
  readonly write: (scope: string, text: string) => void;
  readonly readImages: (scope: string) => ReadonlyArray<File>;
  readonly writeImages: (scope: string, files: ReadonlyArray<File>) => void;
  readonly readCreateFrom: (scope: string) => NewTaskCreateFromSelection | undefined;
  readonly writeCreateFrom: (
    scope: string,
    selection: NewTaskCreateFromSelection | undefined,
  ) => void;
  readonly subscribe: (onStoreChange: () => void) => () => void;
}

export function createNewTaskDrafts(): NewTaskDrafts {
  const drafts = new Map<string, string>();
  const images = new Map<string, ReadonlyArray<File>>();
  const createFrom = new Map<string, NewTaskCreateFromSelection>();
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
    readCreateFrom: (scope) => createFrom.get(scope),
    writeCreateFrom: (scope, selection) => {
      if (selection === undefined) createFrom.delete(scope);
      else createFrom.set(scope, selection);
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
  drafts.writeCreateFrom(scope, undefined);
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

export interface PaneDraftRef {
  readonly mode: "chat" | "work" | "code";
  readonly paneId: string;
}

/**
 * Drafts to drop after a committed workspace update. Settings remounts start
 * from an empty previous list and therefore keep every current draft. An
 * optimistic preview reuses the committed version, so a refused open or close
 * can roll the surface back without this treating the preview as a permanent
 * drop.
 */
function committedDraftsToDiscard<T>(
  previous: ReadonlyArray<T>,
  next: ReadonlyArray<T>,
  keyOf: (surface: T) => string,
  previousCommit?: string | number,
  nextCommit?: string | number,
): ReadonlyArray<T> {
  if (
    previousCommit === undefined ||
    nextCommit === undefined ||
    String(previousCommit) === String(nextCommit)
  ) {
    return [];
  }
  const remaining = new Set(next.map(keyOf));
  const dropped: T[] = [];
  const seen = new Set<string>();
  for (const surface of previous) {
    const key = keyOf(surface);
    if (remaining.has(key) || seen.has(key)) continue;
    seen.add(key);
    dropped.push(surface);
  }
  return dropped;
}

/** Overview drafts to drop when that Project is no longer open in any pane. */
export function projectOverviewDraftsToDiscard(
  previous: ReadonlyArray<ProjectOverviewDraftRef>,
  next: ReadonlyArray<ProjectOverviewDraftRef>,
  previousCommit?: string | number,
  nextCommit?: string | number,
): ReadonlyArray<ProjectOverviewDraftRef> {
  return committedDraftsToDiscard(
    previous,
    next,
    (surface) => `${surface.mode}:${surface.projectId}`,
    previousCommit,
    nextCommit,
  );
}

/**
 * Draft-thread and welcome drafts to drop when that pane is no longer a
 * start composer. Opening a thread replaces the draft without closing the
 * pane, so a later default composer can reuse this pane id.
 */
export function paneDraftsToDiscard(
  previous: ReadonlyArray<PaneDraftRef>,
  next: ReadonlyArray<PaneDraftRef>,
  previousCommit?: string | number,
  nextCommit?: string | number,
): ReadonlyArray<PaneDraftRef> {
  return committedDraftsToDiscard(
    previous,
    next,
    (surface) => `${surface.mode}:${surface.paneId}`,
    previousCommit,
    nextCommit,
  );
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
