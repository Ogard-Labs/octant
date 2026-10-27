import {
  MAX_CODE_DEBUG_BREAKPOINT_FILES,
  MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE,
  type CodeDebugFileBreakpoints,
  type CodeDebugSessionId,
} from "@octant/contracts/code-debug";
import type { CodeRelativePath } from "@octant/contracts/code";
import { useSyncExternalStore } from "react";

/**
 * What this window holds for one thread's debugging: its breakpoints, the
 * file the person last had in the editor, where the program stopped, and the
 * session this window started. Breakpoints are the window's own state for the
 * thread (docs/design/language-services.md § Debugger data and privacy): the
 * host gets them at each Start and keeps none after the session. Nothing here
 * is persisted, so a reload starts with none.
 */
export interface CodeDebugThreadState {
  /** Breakpoint lines by checkout-relative path, one-based and ascending. */
  readonly breakpoints: ReadonlyMap<CodeRelativePath, ReadonlyArray<number>>;
  readonly currentFile?: CodeRelativePath;
  readonly stopped?: { readonly path: CodeRelativePath; readonly line: number };
  readonly session?: { readonly sessionId: CodeDebugSessionId; readonly name: string };
}

const EMPTY: CodeDebugThreadState = { breakpoints: new Map() };

/** One thread on one checkout: a thread bound to another checkout is another place. */
export function codeDebugThreadKey(threadId: string, checkoutId: string): string {
  return JSON.stringify([threadId, checkoutId]);
}

/** A toggle past a bound takes nothing and names the bound: the file's, or the files'. */
export type BreakpointToggle = "added" | "removed" | "file-full" | "files-full";

export class CodeDebugWindowState {
  readonly #threads = new Map<string, CodeDebugThreadState>();
  readonly #listeners = new Set<() => void>();

  read(key: string): CodeDebugThreadState {
    return this.#threads.get(key) ?? EMPTY;
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
  toggleBreakpoint(key: string, path: CodeRelativePath, line: number): BreakpointToggle {
    const current = this.read(key);
    const lines = current.breakpoints.get(path) ?? [];
    const breakpoints = new Map(current.breakpoints);
    let outcome: BreakpointToggle;
    if (lines.includes(line)) {
      const remaining = lines.filter((candidate) => candidate !== line);
      if (remaining.length === 0) breakpoints.delete(path);
      else breakpoints.set(path, remaining);
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
      outcome = "added";
    }
    this.#write(key, { ...current, breakpoints });
    return outcome;
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

  #write(key: string, next: CodeDebugThreadState): void {
    this.#threads.set(key, next);
    for (const listener of this.#listeners) listener();
  }
}

/** The breakpoints a Start or a `set-breakpoints` carries, in the contract's shape. */
export function fileBreakpoints(
  state: CodeDebugThreadState,
): ReadonlyArray<CodeDebugFileBreakpoints> {
  return [...state.breakpoints].map(([path, lines]) => ({
    path,
    breakpoints: lines.map((line) => ({ line })),
  }));
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
