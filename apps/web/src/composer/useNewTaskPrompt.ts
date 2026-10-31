import {
  decodeMentionableThreadId,
  type GithubIssueContextRequest,
  type LinearIssueContextRequest,
  type TerminalSessionImportRequest,
} from "@octant/contracts";
import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import type { PermissionPersistence, ProviderExecutionPolicy } from "@octant/contracts/providers";
import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import type { ComposerExtensionSelection } from "./composerExtensionSelection";

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
    }
  | {
      readonly kind: "terminal";
      readonly request: TerminalSessionImportRequest;
      readonly label: string;
    };

export interface NewTaskCodeCheckoutDraft {
  readonly baseBranch: string;
  readonly baseBranchChosen: boolean;
  readonly workspaceOverride?: CodeNewThreadWorkspace;
  readonly worktreeRemote?: string;
  readonly startFromOriginOverride?: boolean;
  readonly executionPolicy?: ProviderExecutionPolicy;
  readonly permissionPersistence?: PermissionPersistence;
}

export interface NewTaskMentionChip {
  readonly threadId: string;
  readonly title: string;
  readonly mode: "chat" | "work" | "code";
  readonly placementLabel: string;
}

export function mentionChipsToDraft(
  chips: ReadonlyArray<{
    readonly threadId: string | { readonly [key: string]: unknown };
    readonly title: string;
    readonly mode: "chat" | "work" | "code";
    readonly placementLabel: string;
  }>,
): ReadonlyArray<NewTaskMentionChip> {
  return chips.map((chip) => ({
    threadId: String(chip.threadId),
    title: chip.title,
    mode: chip.mode,
    placementLabel: chip.placementLabel,
  }));
}

export function mentionChipsFromDraft(chips: ReadonlyArray<NewTaskMentionChip>): ReadonlyArray<{
  readonly threadId: ReturnType<typeof decodeMentionableThreadId>;
  readonly title: string;
  readonly mode: "chat" | "work" | "code";
  readonly placementLabel: string;
}> {
  const restored: Array<{
    readonly threadId: ReturnType<typeof decodeMentionableThreadId>;
    readonly title: string;
    readonly mode: "chat" | "work" | "code";
    readonly placementLabel: string;
  }> = [];
  for (const chip of chips) {
    try {
      restored.push({
        threadId: decodeMentionableThreadId(chip.threadId),
        title: chip.title,
        mode: chip.mode,
        placementLabel: chip.placementLabel,
      });
    } catch {
      continue;
    }
  }
  return restored;
}

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
  readonly readCodeCheckout: (scope: string) => NewTaskCodeCheckoutDraft | undefined;
  readonly writeCodeCheckout: (
    scope: string,
    checkout: NewTaskCodeCheckoutDraft | undefined,
  ) => void;
  readonly readMentionChips: (scope: string) => ReadonlyArray<NewTaskMentionChip>;
  readonly writeMentionChips: (scope: string, chips: ReadonlyArray<NewTaskMentionChip>) => void;
  readonly readExtensionReceipts: (scope: string) => ReadonlyArray<ComposerExtensionSelection>;
  readonly writeExtensionReceipts: (
    scope: string,
    receipts: ReadonlyArray<ComposerExtensionSelection>,
  ) => void;
  readonly subscribe: (onStoreChange: () => void) => () => void;
}

const NO_IMAGES: ReadonlyArray<File> = [];

function sameDraftFiles(left: ReadonlyArray<File>, right: ReadonlyArray<File>): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((file, index) => file === right[index]);
}

export function createNewTaskDrafts(): NewTaskDrafts {
  const drafts = new Map<string, string>();
  const images = new Map<string, ReadonlyArray<File>>();
  const createFrom = new Map<string, NewTaskCreateFromSelection>();
  const codeCheckouts = new Map<string, NewTaskCodeCheckoutDraft>();
  const mentionChips = new Map<string, ReadonlyArray<NewTaskMentionChip>>();
  const extensionReceipts = new Map<string, ReadonlyArray<ComposerExtensionSelection>>();
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
    readImages: (scope) => images.get(scope) ?? NO_IMAGES,
    writeImages: (scope, files) => {
      const current = images.get(scope) ?? NO_IMAGES;
      if (sameDraftFiles(current, files)) return;
      if (files.length === 0) images.delete(scope);
      else images.set(scope, files);
      notify();
    },
    readCreateFrom: (scope) => createFrom.get(scope),
    writeCreateFrom: (scope, selection) => {
      if (selection === undefined) createFrom.delete(scope);
      else createFrom.set(scope, selection);
    },
    readCodeCheckout: (scope) => codeCheckouts.get(scope),
    writeCodeCheckout: (scope, checkout) => {
      if (checkout === undefined) codeCheckouts.delete(scope);
      else codeCheckouts.set(scope, checkout);
    },
    readMentionChips: (scope) => mentionChips.get(scope) ?? [],
    writeMentionChips: (scope, chips) => {
      if (chips.length === 0) mentionChips.delete(scope);
      else mentionChips.set(scope, chips);
    },
    readExtensionReceipts: (scope) => extensionReceipts.get(scope) ?? [],
    writeExtensionReceipts: (scope, receipts) => {
      if (receipts.length === 0) extensionReceipts.delete(scope);
      else extensionReceipts.set(scope, receipts);
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
  drafts.writeCodeCheckout(scope, undefined);
  drafts.writeMentionChips(scope, []);
  drafts.writeExtensionReceipts(scope, []);
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
  const stored = useSyncExternalStore(
    drafts?.subscribe ?? emptySubscribe,
    () => (scope === undefined || drafts === undefined ? "" : drafts.read(scope)),
    () => "",
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
