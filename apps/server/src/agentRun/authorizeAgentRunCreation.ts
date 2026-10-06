import {
  decodeChatThreadId,
  decodeCodeThreadId,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunParentThreadId,
  type CodeThread,
  type WindowId,
  type WorkspaceLayoutNode,
} from "@octant/contracts";
import {
  defaultAgentRunAuthorityCeilingForMode,
  resolveAgentRunLiveParentGrant,
} from "@octant/domain";
import type { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import type { PersistenceService } from "../persistence/persistenceService";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { WorkThreadProjection } from "../work/workThreadProjection";
import type { AgentRunControlParentFacts } from "./agentRunControlService";

/**
 * The live parent grant a Chat thread gives its children. Chat parents carry
 * no filesystem or shell, so this is a constant — the shape a window-free
 * scheduled resume may claim as well.
 */
const chatParentLiveGrant = (): AgentRunAuthority =>
  resolveAgentRunLiveParentGrant({
    mode: "chat",
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: true,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  });

const workParentLiveGrant = (): AgentRunAuthority =>
  resolveAgentRunLiveParentGrant({
    mode: "work",
    filesystem: true,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: true,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  });

const codeParentLiveGrant = (
  executionPolicy: CodeThread["executionPolicy"],
  permissionPersistence: CodeThread["permissionPersistence"],
): AgentRunAuthority => {
  const planOnly = executionPolicy === "plan";
  return resolveAgentRunLiveParentGrant({
    mode: "code",
    filesystem: true,
    shell: !planOnly,
    git: !planOnly,
    network: !planOnly,
    tools: true,
    subagents: true,
    executionPolicy,
    permissionPersistence,
  });
};

export function authorizeAgentRunCreation(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly windowId: string;
  readonly codeSessionAuthority: CodeSessionAuthorityStore;
}): AgentRunControlParentFacts | undefined {
  const workspace = input.persistence.readWindowWorkspace(input.windowId as WindowId)?.workspace;
  if (workspace === undefined) return undefined;

  const chatContext = workspace.contextByMode.chat;
  let chatThread;
  try {
    chatThread = input.persistence.readChatThread(decodeChatThreadId(String(input.parentThreadId)));
  } catch {
    chatThread = undefined;
  }
  if (
    chatThread !== undefined &&
    chatThread.lifecycle === "active" &&
    chatContext.mode === "chat" &&
    String(chatContext.projectId) === String(chatThread.projectId ?? null) &&
    layoutContainsAgentRunThread(
      workspace.layouts.chat,
      String(chatThread.id),
      String(chatContext.host),
    )
  ) {
    const parentAuthority = defaultAgentRunAuthorityCeilingForMode("chat");
    const liveAuthority = chatParentLiveGrant();
    return {
      parentMode: "chat",
      parentAuthority,
      liveAuthority,
      workspaceParent: { threadId: String(input.parentThreadId), mode: "chat" },
      parentRoute: {
        providerInstanceId: chatThread.providerInstanceId,
        modelId: chatThread.modelId,
        ...(chatThread.projectId === undefined ? {} : { projectId: String(chatThread.projectId) }),
        ...reasoningFromModelOptions(chatThread.modelOptionValues),
      },
    };
  }

  const workContext = workspace.contextByMode.work;
  let workThread;
  try {
    workThread = input.workThreadProjection.read(input.parentThreadId as never);
  } catch {
    workThread = undefined;
  }
  if (
    workThread !== undefined &&
    workThread.lifecycle === "active" &&
    workContext.mode === "work" &&
    String(workContext.projectId) === String(workThread.projectId) &&
    layoutContainsAgentRunThread(
      workspace.layouts.work,
      String(workThread.id),
      String(workContext.host),
    )
  ) {
    const project = input.persistence.readProject(workThread.projectId);
    if (project?.type !== "work" || project.lifecycle !== "active") return undefined;
    const revision = project.bindingHistory.at(-1);
    if (revision === undefined) return undefined;
    const parentAuthority = defaultAgentRunAuthorityCeilingForMode("work");
    const liveAuthority = workParentLiveGrant();
    return {
      parentMode: "work",
      parentAuthority,
      liveAuthority,
      workspaceParent: {
        threadId: String(input.parentThreadId),
        mode: "work",
        projectId: String(project.id),
        bindingRevisionId: String(revision.revisionId),
        canonicalRoot: project.binding.canonicalRoot,
      },
      parentRoute: {
        providerInstanceId: workThread.providerInstanceId,
        modelId: workThread.modelId,
        projectId: String(project.id),
      },
    };
  }

  const codeContext = workspace.contextByMode.code;
  let codeThread;
  try {
    codeThread = input.persistence.readCodeThread(decodeCodeThreadId(String(input.parentThreadId)));
  } catch {
    codeThread = undefined;
  }
  if (
    codeThread !== undefined &&
    codeThread.lifecycle === "active" &&
    codeContext.mode === "code" &&
    String(codeContext.projectId) === String(codeThread.projectId) &&
    layoutContainsAgentRunThread(
      workspace.layouts.code,
      String(codeThread.id),
      String(codeContext.host),
    )
  ) {
    const effectiveThread = input.codeSessionAuthority.effectiveThread(
      input.windowId as WindowId,
      codeThread,
    );
    const parentAuthority = defaultAgentRunAuthorityCeilingForMode("code");
    const liveAuthority = codeParentLiveGrant(
      effectiveThread.executionPolicy,
      effectiveThread.permissionPersistence,
    );
    return {
      parentMode: "code",
      parentAuthority,
      liveAuthority,
      workspaceParent: {
        threadId: String(input.parentThreadId),
        mode: "code",
        projectId: String(codeThread.projectId),
        bindingRevisionId: String(codeThread.bindingRevisionId),
      },
      parentRoute: {
        providerInstanceId: codeThread.providerInstanceId,
        modelId: codeThread.modelId,
        projectId: String(codeThread.projectId),
      },
    };
  }

  return undefined;
}

export function boundAgentRunLiveAuthority(input: {
  readonly persistence: Pick<PersistenceService, "readCodeThread">;
  readonly run: Pick<AgentRun, "requestId" | "parentThreadId"> & {
    readonly routingReceipt: Pick<AgentRun["routingReceipt"], "mode">;
  };
  readonly executionWindows: ReadonlyMap<
    AgentRun["requestId"],
    { readonly windowId: WindowId; readonly parentThreadId: AgentRun["parentThreadId"] }
  >;
  readonly codeSessionAuthority: CodeSessionAuthorityStore;
  readonly windowAuthorityStore: Pick<WindowAuthorityStore, "listWindowIds">;
}): AgentRunAuthority | undefined {
  const binding = input.executionWindows.get(input.run.requestId);
  return scheduledAgentRunLiveAuthority({
    persistence: input.persistence,
    run: input.run,
    // Cached bindings do not extend a window's lifetime. The store's read
    // expires capabilities and revokes their session grants even when no
    // renderer request has authenticated since the child was admitted.
    ...(binding !== undefined &&
    String(binding.parentThreadId) === String(input.run.parentThreadId) &&
    input.windowAuthorityStore.listWindowIds().some((id) => String(id) === String(binding.windowId))
      ? {
          executionWindow: {
            windowId: binding.windowId,
            codeSessionAuthority: input.codeSessionAuthority,
          },
        }
      : {}),
  });
}

/**
 * The live grant a host-scheduled usage resume may claim when no window
 * carries the parent thread. A child admitted by a live window may use only
 * that exact window's grant, even after its parent tab is hidden. Without a
 * host-owned execution binding (including after restart), only the persisted
 * parent posture is available.
 *
 * Returns `undefined` when the parent thread the grant derives from can no
 * longer be read; the dispatch then reports a refusal instead of guessing.
 */
export function scheduledAgentRunLiveAuthority(input: {
  readonly persistence: Pick<PersistenceService, "readCodeThread">;
  readonly run: Pick<AgentRun, "parentThreadId"> & {
    readonly routingReceipt: Pick<AgentRun["routingReceipt"], "mode">;
  };
  readonly executionWindow?: {
    readonly windowId: WindowId;
    readonly codeSessionAuthority: CodeSessionAuthorityStore;
  };
}): AgentRunAuthority | undefined {
  switch (input.run.routingReceipt.mode) {
    case "chat":
      return chatParentLiveGrant();
    case "work":
      return workParentLiveGrant();
    case "code": {
      let codeThread;
      try {
        codeThread = input.persistence.readCodeThread(
          decodeCodeThreadId(String(input.run.parentThreadId)),
        );
      } catch {
        return undefined;
      }
      if (codeThread === undefined || codeThread.lifecycle !== "active") return undefined;
      const thread =
        input.executionWindow?.codeSessionAuthority.effectiveThread(
          input.executionWindow.windowId,
          codeThread,
        ) ?? codeThread;
      return codeParentLiveGrant(thread.executionPolicy, thread.permissionPersistence);
    }
    default:
      return undefined;
  }
}

export function layoutContainsAgentRunThread(
  layout: WorkspaceLayoutNode,
  threadId: string,
  hostId: string,
): boolean {
  if (layout.kind === "split") {
    return (
      layoutContainsAgentRunThread(layout.first, threadId, hostId) ||
      layoutContainsAgentRunThread(layout.second, threadId, hostId)
    );
  }
  const surface = layout.surface;
  if (!("threadId" in surface) || String(surface.threadId) !== threadId) return false;
  return (
    !("hostId" in surface) || surface.hostId === undefined || String(surface.hostId) === hostId
  );
}

function reasoningFromModelOptions(
  values: Readonly<Record<string, string>> | undefined,
): { readonly reasoning: string } | Record<string, never> {
  if (values === undefined) return {};
  const value = values.reasoning ?? values.effort;
  if (value === undefined || value.trim().length === 0) return {};
  return { reasoning: value.trim().slice(0, 128) };
}
