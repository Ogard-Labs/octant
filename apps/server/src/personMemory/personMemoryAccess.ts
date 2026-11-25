import type { OctantMode, ProviderInstanceId, WindowId } from "@octant/contracts";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { createPastThreadsTools } from "./pastThreadsTool";
import { createRememberPersonTools, type PersonTurnMessage } from "./rememberPersonTool";
import type { PersonMemoryStore } from "./personMemoryStore";

export interface PersonMemoryTurnScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
  /** The turn's principal scope; absent when no window or host scope started it. */
  readonly windowId: WindowId | undefined;
}

/**
 * A turn's scope with what saving needs: the thread's title and provider to name
 * it as a source, and a reader for what the person wrote. A turn that cannot say
 * these is offered search only.
 */
export interface PersonMemoryToolScope extends PersonMemoryTurnScope {
  readonly title?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  /**
   * The messages of the turn this scope was built for (its own prompt, and any
   * steered into it), each with the id its typed mark is kept under. Read again
   * on every save; absent, the turn is offered search only.
   */
  readonly turnMessages?: (() => ReadonlyArray<PersonTurnMessage>) | undefined;
}

export interface PersonMemoryAccess {
  /**
   * Records that the person typed a turn's message. Called by the host after it
   * admitted a turn the person's own route said was typed, never from request
   * data a service could read.
   */
  readonly markTurnTyped: (input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly turnId: string;
    readonly projectId?: string | undefined;
  }) => void;
  readonly blockFor: (scope: PersonMemoryTurnScope) => string | undefined;
  readonly toolsFor: (scope: PersonMemoryToolScope) => AppManagedToolSet | undefined;
  readonly childBlockFor: (lead: PersonMemoryTurnScope) => string | undefined;
  readonly childToolsFor: (
    lead: PersonMemoryTurnScope,
    authority: { readonly tools: boolean },
    currentWindowId?: () => WindowId | undefined,
  ) => AppManagedToolSet | undefined;
}

/**
 * Person memory as a turn or subagent may read it, and as a turn with the
 * person's own message may write it (`toolsFor` adds the save tool; a turn the
 * host started, and every subagent, only reads). A local window, a paired
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
  readonly store: Pick<
    PersonMemoryStore,
    | "blockFor"
    | "search"
    | "searchOffered"
    | "threadTakesPart"
    | "saveFromOpenThread"
    | "isTurnTyped"
    | "markTurnTyped"
    | "saveRefusal"
  >;
  readonly isRestrictedDeviceScope?: (scopeId: WindowId) => boolean;
  /**
   * Threads that must never read host-wide person memory even under a host
   * scope (for example, Work threads created to run a peer-delegated task).
   */
  readonly isThreadWithheld?: (threadId: string) => boolean;
  readonly projectLabel: (projectId: string) => string | undefined;
  /**
   * Saving what the person asks to be remembered. Absent, no turn is offered
   * the save tool.
   */
  readonly save?: {
    readonly namesProtectedPath: (text: string) => boolean;
    /** A turn the host started as itself, which carries no words of the person's own. */
    readonly isHostScope: (scopeId: WindowId) => boolean;
  };
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
  const saveToolsFor = (scope: PersonMemoryToolScope): AppManagedToolSet | undefined => {
    const { save } = input;
    if (
      save === undefined ||
      scope.windowId === undefined ||
      save.isHostScope(scope.windowId) ||
      scope.title === undefined ||
      scope.providerInstanceId === undefined ||
      scope.turnMessages === undefined ||
      !input.store.threadTakesPart(scope)
    ) {
      return undefined;
    }
    return createRememberPersonTools({
      store: input.store,
      thread: {
        mode: scope.mode,
        threadId: scope.threadId,
        projectId: scope.projectId,
        title: scope.title,
        providerInstanceId: scope.providerInstanceId,
      },
      turnMessages: scope.turnMessages,
      namesProtectedPath: save.namesProtectedPath,
    });
  };
  return {
    markTurnTyped: (turn) => input.store.markTurnTyped(turn),
    blockFor: (scope) =>
      scopeReadsPersonMemory(scope.windowId, scope.threadId)
        ? input.store.blockFor(scope)
        : undefined,
    toolsFor: (scope) => {
      if (!scopeReadsPersonMemory(scope.windowId, scope.threadId)) return undefined;
      const search = toolsForThread(scope);
      const remember = saveToolsFor(scope);
      return search === undefined && remember === undefined
        ? undefined
        : combineAppManagedToolSets(search, remember);
    },
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
