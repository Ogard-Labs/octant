import type { OctantMode, WindowId } from "@octant/contracts";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import { createPastThreadsTools } from "./pastThreadsTool";
import type { PersonMemoryStore } from "./personMemoryStore";

export interface PersonMemoryTurnScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
  /** The turn's principal scope; absent when no window or host scope started it. */
  readonly windowId: WindowId | undefined;
}

export interface PersonMemoryAccess {
  readonly blockFor: (scope: PersonMemoryTurnScope) => string | undefined;
  readonly toolsFor: (scope: PersonMemoryTurnScope) => AppManagedToolSet | undefined;
  readonly childBlockFor: (lead: PersonMemoryTurnScope) => string | undefined;
  readonly childToolsFor: (
    lead: PersonMemoryTurnScope,
    authority: { readonly tools: boolean },
    currentWindowId?: () => WindowId | undefined,
  ) => AppManagedToolSet | undefined;
}

/**
 * Person memory as a turn or subagent may read it. A local window, a paired
 * device the host's own person approved, and a turn the host starts as itself
 * (a routine's run, a resumed turn, a delivered child result, or a goal round)
 * each read it; a device known only through a hub's roster, a peer-delegated
 * thread, and a turn with no scope (such as a benchmark runner's Chat turn) do
 * not. A subagent inherits its originating lead turn's scope restriction and
 * reads through its lead thread (`childBlockFor` / `childToolsFor`), failing
 * closed when the originating scope is absent or restricted. `threadTakesPart`
 * still decides per thread (memory on, Project not kept out, thread not Leave
 * no trace).
 */
export function createPersonMemoryAccess(input: {
  readonly store: Pick<PersonMemoryStore, "blockFor" | "search" | "searchOffered">;
  readonly isRestrictedDeviceScope?: (scopeId: WindowId) => boolean;
  /**
   * Threads that must never read host-wide person memory even under a host
   * scope (for example, Work threads created to run a peer-delegated task).
   */
  readonly isThreadWithheld?: (threadId: string) => boolean;
  readonly projectLabel: (projectId: string) => string | undefined;
}): PersonMemoryAccess {
  const scopeReadsPersonMemory = (windowId: WindowId | undefined, threadId: string): boolean =>
    windowId !== undefined &&
    input.isRestrictedDeviceScope?.(windowId) !== true &&
    input.isThreadWithheld?.(threadId) !== true;
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
      scopeReadsPersonMemory(scope.windowId, scope.threadId)
        ? input.store.blockFor(scope)
        : undefined,
    toolsFor: (scope) =>
      scopeReadsPersonMemory(scope.windowId, scope.threadId) ? toolsForThread(scope) : undefined,
    childBlockFor: (lead) =>
      scopeReadsPersonMemory(lead.windowId, lead.threadId) ? input.store.blockFor(lead) : undefined,
    childToolsFor: (lead, authority, currentWindowId) => {
      if (!authority.tools || !scopeReadsPersonMemory(lead.windowId, lead.threadId)) {
        return undefined;
      }
      const tools = toolsForThread(lead);
      if (tools === undefined || currentWindowId === undefined) return tools;
      return {
        ...tools,
        execute: async (call) => {
          if (!scopeReadsPersonMemory(currentWindowId(), lead.threadId)) {
            return {
              result: { error: "Searching past threads is not available for this session." },
              isError: true,
            };
          }
          return tools.execute(call);
        },
      };
    },
  };
}
