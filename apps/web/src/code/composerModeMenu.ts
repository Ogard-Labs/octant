import { useEffect, useSyncExternalStore } from "react";

type ModeMenuOpener = () => void;

const PENDING_OPEN_TTL_MS = 5_000;

/**
 * Window-local registry connecting a Code thread's Plan-mode panes (Git, Pull
 * request, Terminal, Tests) to that thread's composer mode menu.
 *
 * Clicking "Change mode" opens the composer's mode menu so the person chooses
 * the next mode themselves — nothing switches automatically. If the thread's
 * composer is currently unmounted (for example, when Git or Pull request holds
 * the thread's tab slot), a brief pending request opens the menu once the
 * thread tab mounts again.
 */
export interface ComposerModeMenuRegistry {
  readonly register: (threadId: string, open: ModeMenuOpener) => () => void;
  readonly open: (threadId: string) => boolean;
  readonly hasOpener: (threadId: string) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createComposerModeMenuRegistry(
  now: () => number = () => Date.now(),
): ComposerModeMenuRegistry {
  const openers = new Map<string, Set<ModeMenuOpener>>();
  const listeners = new Set<() => void>();
  let pending: { readonly threadId: string; readonly expiresAt: number } | undefined;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const openerOf = (threadId: string): ModeMenuOpener | undefined =>
    openers.get(threadId)?.values().next().value;

  return {
    register(threadId, open) {
      const set = openers.get(threadId) ?? new Set<ModeMenuOpener>();
      const hadNone = set.size === 0;
      set.add(open);
      openers.set(threadId, set);
      if (hadNone) notify();
      if (pending !== undefined && pending.threadId === threadId) {
        const currentPending = pending;
        pending = undefined;
        if (now() <= currentPending.expiresAt) {
          queueMicrotask(() => {
            if (set.has(open)) open();
          });
        }
      }
      return () => {
        set.delete(open);
        if (set.size === 0) {
          openers.delete(threadId);
          notify();
        }
      };
    },
    open(threadId) {
      const opener = openerOf(threadId);
      if (opener !== undefined) {
        if (pending?.threadId === threadId) pending = undefined;
        opener();
        return true;
      }
      pending = { threadId, expiresAt: now() + PENDING_OPEN_TTL_MS };
      return false;
    },
    hasOpener(threadId) {
      return openerOf(threadId) !== undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const composerModeMenu = createComposerModeMenuRegistry();

export function useRegisterComposerModeMenu(
  threadId: string | undefined,
  open: ModeMenuOpener | undefined,
): void {
  useEffect(() => {
    if (threadId === undefined || open === undefined) return;
    return composerModeMenu.register(threadId, open);
  }, [threadId, open]);
}

export function useHasComposerModeMenu(threadId: string | undefined): boolean {
  return useSyncExternalStore(
    composerModeMenu.subscribe,
    () => (threadId === undefined ? false : composerModeMenu.hasOpener(threadId)),
    () => false,
  );
}
