import {
  decodeChatThreadId,
  decodeCodeThreadId,
  type AgentRunParentThreadId,
  type WindowId,
  type WorkspaceLayoutNode,
} from "@octant/contracts";
import {
  defaultAgentRunAuthorityCeilingForMode,
  resolveAgentRunLiveParentGrant,
} from "@octant/domain";
import type { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import type { PersistenceService } from "../persistence/persistenceService";
import type { WorkThreadProjection } from "../work/workThreadProjection";
import type { AgentRunControlParentFacts } from "./agentRunControlService";

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
    const liveAuthority = resolveAgentRunLiveParentGrant({
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
    const liveAuthority = resolveAgentRunLiveParentGrant({
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
    const planOnly = effectiveThread.executionPolicy === "plan";
    const liveAuthority = resolveAgentRunLiveParentGrant({
      mode: "code",
      filesystem: true,
      shell: !planOnly,
      git: !planOnly,
      network: !planOnly,
      tools: true,
      subagents: true,
      executionPolicy: effectiveThread.executionPolicy,
      permissionPersistence: effectiveThread.permissionPersistence,
    });
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
