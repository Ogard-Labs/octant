import {
  MAX_CODE_DEBUG_BREAKPOINT_FILES,
  MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE,
  type CodeDebugFileBreakpoints,
  type CodeDebugSessionId,
} from "@octant/contracts/code-debug";
import type { CodeFileId, CodeFileMetadata, CodeRelativePath } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { useSyncExternalStore } from "react";
import {
  isCodeBreakpointLine,
  breakpointStorageEventMatches,
  readCodeBreakpointConfiguration,
  writeCodeBreakpointConfiguration,
  purgeCodeBreakpointConfiguration,
  type CodeBreakpointBinding,
  type CodeBreakpointScope,
  type CodeBreakpointStorage,
} from "./codeBreakpointStorage";

/**
 * What this window holds for one thread's debugging: its breakpoints, the
 * file the person last had in the editor, where the program stopped, and the
 * session this window started. Breakpoints are the window's own state for the
 * thread (docs/design/language-services.md § Debugger data and privacy): the
 * host gets them at each Start and keeps none after the session. Nothing here
 * except breakpoint configuration is persisted; restored locations must be
 * matched against an authorized file read before reaching an adapter.
 */
export interface CodeDebugThreadState {
  /** Breakpoint lines by checkout-relative path, one-based and ascending. */
  readonly breakpoints: ReadonlyMap<CodeRelativePath, ReadonlyArray<number>>;
  readonly breakpointFiles?: ReadonlyMap<CodeRelativePath, CodeBreakpointFileState>;
  readonly persistenceWarning?: string;
  readonly currentFile?: CodeRelativePath;
  readonly stopped?: { readonly path: CodeRelativePath; readonly line: number };
  readonly session?: { readonly sessionId: CodeDebugSessionId; readonly name: string };
}

const EMPTY: CodeDebugThreadState = { breakpoints: new Map() };
const PERSISTENT_EMPTY: CodeDebugThreadState = {
  breakpoints: new Map(),
  breakpointFiles: new Map(),
};
const STORAGE_WARNING =
  "Breakpoint changes could not be saved on this device. Keep this window open and check browser storage before relying on them after reload.";
const PURGE_WARNING =
  "Some saved breakpoints could not be removed from this device. Repair browser storage and purge this thread again.";
export interface CodeBreakpointFileObservation {
  readonly projectId: ProjectId;
  readonly fileId: CodeFileId;
  readonly metadata: CodeFileMetadata;
  readonly lineCount: number;
  readonly clean: boolean;
}
export type CodeBreakpointUnresolvedReason =
  | "not-checked"
  | "changed"
  | "missing"
  | "unavailable"
  | "unsaved"
  | "unconfirmed"
  | "line-missing"
  | "project-changed";
export interface CodeBreakpointFileState {
  readonly binding?: CodeBreakpointBinding;
  readonly observed?: CodeBreakpointFileObservation;
  readonly status: "verified" | "unresolved";
  readonly reason?: CodeBreakpointUnresolvedReason;
}

/** One thread on one checkout: a thread bound to another checkout is another place. */
export function codeDebugThreadKey(threadId: string, checkoutId: string): string {
  return JSON.stringify([threadId, checkoutId]);
}

/** A toggle past a bound takes nothing and names the bound: the file's, or the files'. */
export type BreakpointToggle = "added" | "removed" | "file-full" | "files-full" | "invalid-line";

export class CodeDebugWindowState {
  readonly #threads = new Map<string, CodeDebugThreadState>();
  readonly #listeners = new Set<() => void>();
  readonly #editorDrafts = new Map<
    string,
    Map<object, { readonly read: () => boolean; active: boolean }>
  >();

  /** A pane owns its live draft; the existing draft store owns it across remounts. */
  trackEditor(
    key: string,
    path: CodeRelativePath,
    owner: object,
    dirty: () => boolean,
  ): () => void {
    const editor = JSON.stringify([key, path]);
    const owners =
      this.#editorDrafts.get(editor) ??
      new Map<object, { readonly read: () => boolean; active: boolean }>();
    this.#editorDrafts.set(editor, owners);
    const entry = { read: dirty, active: true };
    owners.set(owner, entry);
    return () => {
      if (owners.get(owner) !== entry) return;
      entry.active = false;
      if (!dirty()) owners.delete(owner);
      if (owners.size === 0) this.#editorDrafts.delete(editor);
    };
  }

  #hasDirtyEditor(editor: string): boolean {
    let dirty = false;
    const owners = this.#editorDrafts.get(editor);
    for (const [owner, entry] of owners ?? []) {
      if (entry.read()) dirty = true;
      else if (!entry.active) owners?.delete(owner);
    }
    if (owners?.size === 0) this.#editorDrafts.delete(editor);
    return dirty;
  }
  readonly #persistence:
    | (CodeBreakpointScope & { readonly storage: CodeBreakpointStorage | undefined })
    | undefined;

  constructor(
    persistence?: CodeBreakpointScope & { readonly storage: CodeBreakpointStorage | undefined },
  ) {
    this.#persistence = persistence;
  }

  read(key: string): CodeDebugThreadState {
    const held = this.#threads.get(key);
    if (held !== undefined) return held;
    const restored = this.#restore(key);
    this.#threads.set(key, restored);
    return restored;
  }

  #restore(key: string): CodeDebugThreadState {
    const scope = this.#persistence;
    if (scope === undefined) return EMPTY;
    const saved = readCodeBreakpointConfiguration(scope.storage, scope, key);
    if (saved.status !== "read")
      return saved.status === "unavailable"
        ? { ...PERSISTENT_EMPTY, persistenceWarning: STORAGE_WARNING }
        : PERSISTENT_EMPTY;
    return {
      breakpoints: new Map(saved.files.map((file) => [file.path, file.lines])),
      breakpointFiles: new Map(
        saved.files.map((file) => [
          file.path,
          {
            ...(file.binding === undefined ? {} : { binding: file.binding }),
            status: "unresolved",
            reason: "not-checked",
          },
        ]),
      ),
    };
  }

  /** Storage changes replace configuration only, never a running session's values. */
  reloadFromStorage(eventKey?: string | null): void {
    if (this.#persistence === undefined) return;
    for (const [key, current] of this.#threads) {
      if (
        eventKey !== undefined &&
        !breakpointStorageEventMatches(this.#persistence, eventKey, key)
      )
        continue;
      const {
        breakpoints: _lines,
        breakpointFiles: _files,
        persistenceWarning: _warning,
        ...runtime
      } = current;
      this.#threads.set(key, { ...runtime, ...this.#restore(key) });
    }
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Adds or removes one breakpoint. A file past the per-file bound, or a new
   * file past the file bound, takes none: the host would refuse the Start.
   */
  toggleBreakpoint(
    key: string,
    path: CodeRelativePath,
    line: number,
    observation?: CodeBreakpointFileObservation,
  ): BreakpointToggle {
    if (!isCodeBreakpointLine(line)) return "invalid-line";
    const current = this.read(key);
    const lines = current.breakpoints.get(path) ?? [];
    const breakpoints = new Map(current.breakpoints);
    const files = new Map(current.breakpointFiles);
    let outcome: BreakpointToggle;
    if (lines.includes(line)) {
      const remaining = lines.filter((candidate) => candidate !== line);
      if (remaining.length === 0) breakpoints.delete(path);
      else breakpoints.set(path, remaining);
      if (remaining.length === 0) {
        files.delete(path);
      }
      outcome = "removed";
    } else if (lines.length >= MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE) {
      return "file-full";
    } else if (lines.length === 0 && breakpoints.size >= MAX_CODE_DEBUG_BREAKPOINT_FILES) {
      return "files-full";
    } else {
      breakpoints.set(
        path,
        [...lines, line].sort((left, right) => left - right),
      );
      if (this.#persistence !== undefined || current.breakpointFiles !== undefined) {
        let binding = files.get(path)?.binding;
        const observed = observation ?? files.get(path)?.observed;
        if (observed !== undefined && lines.length === 0) binding = bindingFrom(observed);
        else if (
          binding !== undefined &&
          (observed === undefined || !observed.clean || !sameFile(binding, observed))
        )
          binding = { ...binding, unconfirmed: true };
        files.set(path, fileState(binding, observed, breakpoints.get(path) ?? []));
      }
      outcome = "added";
    }
    this.#write(
      key,
      {
        ...current,
        breakpoints,
        ...(this.#persistence === undefined && current.breakpointFiles === undefined
          ? {}
          : { breakpointFiles: files }),
      },
      true,
    );
    return outcome;
  }

  removeBreakpoint(key: string, path: CodeRelativePath, line: number): void {
    if (!this.read(key).breakpoints.get(path)?.includes(line)) return;
    this.toggleBreakpoint(key, path, line);
  }

  observeFile(
    key: string,
    path: CodeRelativePath,
    observation: CodeBreakpointFileObservation | undefined,
    reason: CodeBreakpointUnresolvedReason = "unavailable",
  ): void {
    const current = this.read(key);
    const lines = current.breakpoints.get(path);
    if (
      lines === undefined ||
      (this.#persistence === undefined && current.breakpointFiles === undefined)
    )
      return;
    const editor = JSON.stringify([key, path]);
    if (observation !== undefined && this.#hasDirtyEditor(editor))
      observation = { ...observation, clean: false };
    const files = new Map(current.breakpointFiles);
    const binding = files.get(path)?.binding;
    files.set(
      path,
      observation === undefined
        ? { ...(binding === undefined ? {} : { binding }), status: "unresolved", reason }
        : fileState(binding, observation, lines),
    );
    this.#write(key, { ...current, breakpointFiles: files });
  }

  reacceptFile(key: string, path: CodeRelativePath): boolean {
    const current = this.read(key);
    const observed = current.breakpointFiles?.get(path)?.observed;
    const lines = current.breakpoints.get(path);
    if (
      observed === undefined ||
      this.#hasDirtyEditor(JSON.stringify([key, path])) ||
      !observed.clean ||
      lines === undefined ||
      lines.some((line) => line > observed.lineCount)
    )
      return false;
    const files = new Map(current.breakpointFiles);
    files.set(path, fileState(bindingFrom(observed), observed, lines));
    this.#write(key, { ...current, breakpointFiles: files }, true);
    return true;
  }

  purgeThread(threadId: string): boolean {
    const scope = this.#persistence;
    const removed =
      scope === undefined || purgeCodeBreakpointConfiguration(scope.storage, scope, threadId);
    for (const key of this.#threads.keys()) {
      try {
        const parts: unknown = JSON.parse(key);
        if (Array.isArray(parts) && parts[0] === threadId) {
          for (const path of this.#threads.get(key)?.breakpoints.keys() ?? []) {
            this.#editorDrafts.delete(JSON.stringify([key, path]));
          }
          this.#threads.set(
            key,
            removed
              ? scope === undefined
                ? EMPTY
                : PERSISTENT_EMPTY
              : { ...PERSISTENT_EMPTY, persistenceWarning: PURGE_WARNING },
          );
        }
      } catch {
        /* In-memory standalone callers may use keys without a persisted namespace. */
      }
    }
    for (const listener of this.#listeners) listener();
    return removed;
  }

  setCurrentFile(key: string, path: CodeRelativePath): void {
    const current = this.read(key);
    if (current.currentFile === path) return;
    this.#write(key, { ...current, currentFile: path });
  }

  setStopped(key: string, stopped: CodeDebugThreadState["stopped"]): void {
    const current = this.read(key);
    if (current.stopped?.path === stopped?.path && current.stopped?.line === stopped?.line) return;
    const { stopped: _previous, ...rest } = current;
    this.#write(key, stopped === undefined ? rest : { ...rest, stopped });
  }

  setSession(key: string, session: CodeDebugThreadState["session"]): void {
    const current = this.read(key);
    const { session: _previous, ...rest } = current;
    this.#write(key, session === undefined ? rest : { ...rest, session });
  }

  #write(key: string, next: CodeDebugThreadState, changed = false): void {
    const scope = this.#persistence;
    if (changed && scope !== undefined) {
      const result = writeCodeBreakpointConfiguration(
        scope.storage,
        scope,
        key,
        [...next.breakpoints].map(([path, lines]) => {
          const binding = next.breakpointFiles?.get(path)?.binding;
          return { path, lines, ...(binding === undefined ? {} : { binding }) };
        }),
      );
      if (result === "purged") next = PERSISTENT_EMPTY;
      else if (result === "unavailable") next = { ...next, persistenceWarning: STORAGE_WARNING };
      else {
        const { persistenceWarning: _warning, ...saved } = next;
        next = saved;
      }
    }
    this.#threads.set(key, next);
    for (const listener of this.#listeners) listener();
  }
}

/** The breakpoints a Start or a `set-breakpoints` carries, in the contract's shape. */
export function fileBreakpoints(
  state: CodeDebugThreadState,
): ReadonlyArray<CodeDebugFileBreakpoints> {
  return [...activeBreakpoints(state)].map(([path, lines]) => ({
    path,
    breakpoints: lines.map((line) => ({ line })),
  }));
}

export function activeBreakpoints(
  state: CodeDebugThreadState,
): CodeDebugThreadState["breakpoints"] {
  return state.breakpointFiles === undefined
    ? state.breakpoints
    : new Map(
        [...state.breakpoints].filter(
          ([path]) => state.breakpointFiles?.get(path)?.status === "verified",
        ),
      );
}

function bindingFrom(observation: CodeBreakpointFileObservation): CodeBreakpointBinding {
  return {
    projectId: observation.projectId,
    fileId: observation.fileId,
    metadata: observation.metadata,
    ...(observation.clean ? {} : { unconfirmed: true as const }),
  };
}
function sameFile(
  binding: CodeBreakpointBinding,
  observation: CodeBreakpointFileObservation,
): boolean {
  return (
    String(binding.projectId) === String(observation.projectId) &&
    String(binding.fileId) === String(observation.fileId) &&
    binding.metadata.identity.device === observation.metadata.identity.device &&
    binding.metadata.identity.inode === observation.metadata.identity.inode &&
    binding.metadata.digest === observation.metadata.digest
  );
}
function fileState(
  binding: CodeBreakpointBinding | undefined,
  observed: CodeBreakpointFileObservation | undefined,
  lines: ReadonlyArray<number>,
): CodeBreakpointFileState {
  const reason: CodeBreakpointUnresolvedReason | undefined =
    observed === undefined
      ? "not-checked"
      : !observed.clean
        ? "unsaved"
        : lines.some((line) => line > observed.lineCount)
          ? "line-missing"
          : binding === undefined
            ? "not-checked"
            : binding.unconfirmed
              ? "unconfirmed"
              : String(binding.projectId) !== String(observed.projectId)
                ? "project-changed"
                : !sameFile(binding, observed)
                  ? "changed"
                  : undefined;
  return {
    ...(binding === undefined ? {} : { binding }),
    ...(observed === undefined ? {} : { observed }),
    status: reason === undefined ? "verified" : "unresolved",
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The window's one store: the editor and the Run and debug panel share it. */
export const codeDebugWindowState = new CodeDebugWindowState();

export function useCodeDebugThreadState(
  key: string,
  store: CodeDebugWindowState = codeDebugWindowState,
): CodeDebugThreadState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.read(key),
  );
}
