import type { OctantMode, WindowId } from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createPastThreadsTools } from "./pastThreadsTool";
import type { PersonMemoryStore } from "./personMemoryStore";

export interface PersonMemoryLeadScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
}

export interface PersonMemoryTurnScope extends PersonMemoryLeadScope {
  /** The turn's principal scope; absent when no window or host scope started it. */
  readonly windowId: WindowId | undefined;
}

export interface PersonMemoryAccess {
  readonly blockFor: (scope: PersonMemoryTurnScope) => string | undefined;
  readonly toolsFor: (scope: PersonMemoryTurnScope) => AppManagedToolSet | undefined;
  readonly childBlockFor: (lead: PersonMemoryLeadScope) => string | undefined;
  readonly childToolsFor: (
    lead: PersonMemoryLeadScope,
    authority: { readonly tools: boolean },
  ) => AppManagedToolSet | undefined;
}

/**
 * Person memory as a turn or subagent may read it. A local window, a paired
 * device the host's own person approved, and a turn the host starts as itself
 * (a routine's run, a resumed turn, a delivered child result, or a goal round)
 * each read it; a device known only through a hub's roster and a turn with no
 * scope (such as a benchmark runner's Chat turn) do not. A subagent reads
 * through its lead thread's own scope (`childBlockFor` / `childToolsFor`), so
 * it sees what its lead sees and never more. `threadTakesPart` still decides
 * per thread (memory on, Project not kept out, thread not Leave no trace).
 */
export function createPersonMemoryAccess(input: {
  readonly store: Pick<PersonMemoryStore, "blockFor" | "search" | "searchOffered">;
  readonly isRestrictedDeviceScope?: (scopeId: WindowId) => boolean;
  readonly projectLabel: (projectId: string) => string | undefined;
}): PersonMemoryAccess {
  const scopeReadsPersonMemory = (windowId: WindowId | undefined): boolean =>
    windowId !== undefined && input.isRestrictedDeviceScope?.(windowId) !== true;
  const toolsForThread = (thread: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId?: string | undefined;
  }): AppManagedToolSet | undefined =>
    createPastThreadsTools({
      store: input.store,
      thread,
      projectLabel: input.projectLabel,
    });
  return {
    blockFor: (scope) =>
      scopeReadsPersonMemory(scope.windowId) ? input.store.blockFor(scope) : undefined,
    toolsFor: (scope) =>
      scopeReadsPersonMemory(scope.windowId) ? toolsForThread(scope) : undefined,
    childBlockFor: (lead) => input.store.blockFor(lead),
    childToolsFor: (lead, authority) => (authority.tools ? toolsForThread(lead) : undefined),
  };
}
