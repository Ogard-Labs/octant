import type { OctantMode, WindowId } from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createPastThreadsTools } from "./pastThreadsTool";
import type { PersonMemoryStore } from "./personMemoryStore";

export interface PersonMemoryTurnScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
  /** The turn's principal scope; absent when no window started it. */
  readonly windowId: WindowId | undefined;
}

export interface PersonMemoryAccess {
  readonly blockFor: (scope: PersonMemoryTurnScope) => string | undefined;
  readonly toolsFor: (scope: PersonMemoryTurnScope) => AppManagedToolSet | undefined;
}

/**
 * Person memory as a turn may use it. Only a turn a window on this host
 * started reads it: a paired device may be granted only some Projects while
 * memory crosses them, and a turn the host starts as itself (a routine's run,
 * a resumed or delivered turn) has no person at the window.
 */
export function createPersonMemoryAccess(input: {
  readonly store: Pick<PersonMemoryStore, "blockFor" | "search" | "searchOffered">;
  readonly isPairedDeviceScope: (scopeId: WindowId) => boolean;
  readonly isHostScope: (scopeId: WindowId) => boolean;
  readonly projectLabel: (projectId: string) => string | undefined;
}): PersonMemoryAccess {
  const fromLocalWindow = (windowId: WindowId | undefined) =>
    windowId !== undefined && !input.isPairedDeviceScope(windowId) && !input.isHostScope(windowId);
  return {
    blockFor: (scope) =>
      fromLocalWindow(scope.windowId) ? input.store.blockFor(scope) : undefined,
    toolsFor: (scope) =>
      fromLocalWindow(scope.windowId)
        ? createPastThreadsTools({
            store: input.store,
            thread: scope,
            projectLabel: input.projectLabel,
          })
        : undefined,
  };
}
