import {
  decodeAgentRunParentThreadId,
  decodeChatThread,
  decodeChatThreadId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeLayoutNodeId,
  decodePaneId,
  decodeProjectId,
  decodeWindowId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  decodeWorkThread,
  decodeWorkThreadId,
  type ChatThreadId,
  type CodeThreadId,
  type Project,
  type WindowWorkspace,
  type WorkThreadId,
  type WorkspaceLayoutNode,
  type WorkspaceTab,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { contextKeyForProject, defaultWindowWorkspace } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import {
  authorizeAgentRunCreation,
  layoutContainsAgentRunThread,
} from "./authorizeAgentRunCreation";

const now = "2026-08-29T12:00:00.000Z";
const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-00000000a001"),
  chat: decodeChatThreadId("00000000-0000-4000-8000-00000000a010"),
  work: decodeWorkThreadId("00000000-0000-4000-8000-00000000a020"),
  code: decodeCodeThreadId("00000000-0000-4000-8000-00000000a030"),
  project: decodeProjectId("00000000-0000-4000-8000-00000000a040"),
  otherProject: decodeProjectId("00000000-0000-4000-8000-00000000a041"),
  binding: "00000000-0000-4000-8000-00000000a050",
  provider: "00000000-0000-4000-8000-00000000a060",
  tab: decodeWorkspaceTabId("00000000-0000-4000-8000-00000000a070"),
  pane: decodePaneId("00000000-0000-4000-8000-00000000a071"),
  node: decodeLayoutNodeId("00000000-0000-4000-8000-00000000a072"),
};

function parentId(threadId: string) {
  return decodeAgentRunParentThreadId(threadId);
}

function paneWith(surface: WorkspaceTab): WorkspaceLayoutNode {
  return {
    kind: "pane",
    nodeId: ids.node,
    paneId: ids.pane,
    surface,
  };
}

function withSurface(
  workspace: WindowWorkspace,
  mode: "chat" | "work" | "code",
  surface: Parameters<typeof paneWith>[0],
): WindowWorkspace {
  return {
    ...workspace,
    layouts: { ...workspace.layouts, [mode]: paneWith(surface) },
    activePaneIds: { ...workspace.activePaneIds, [mode]: ids.pane },
  };
}

function chatThread() {
  return decodeChatThread({
    id: ids.chat,
    title: "Planning",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be useful.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function workThread() {
  return decodeWorkThread({
    id: ids.work,
    projectId: ids.project,
    title: "Brief",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function codeThread(executionPolicy: "plan" | "approval-gated" = "approval-gated") {
  return decodeCodeThread({
    id: ids.code,
    projectId: ids.project,
    bindingRevisionId: ids.binding,
    repositoryId: `repo_${"d".repeat(64)}`,
    checkoutId: "00000000-0000-4000-8000-00000000a080",
    title: "Implement",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: "model-a",
    executionPolicy,
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/x",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function workProject(): Project {
  return {
    id: ids.project,
    name: "Knowledge",
    type: "work",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/home/folder" },
    bindingHistory: [
      {
        revisionId: ids.binding,
        revision: 1,
        currentBinding: { canonicalRoot: "/home/folder" },
        actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-00000000a090" },
        changedAt: now,
      },
    ],
  } as unknown as Project;
}

function authorize(input: {
  readonly workspace?: WindowWorkspace;
  readonly chat?: ReturnType<typeof chatThread>;
  readonly work?: ReturnType<typeof workThread>;
  readonly code?: ReturnType<typeof codeThread>;
  readonly project?: Project;
  readonly parentThreadId: string;
  readonly authority?: CodeSessionAuthorityStore;
}) {
  return authorizeAgentRunCreation({
    persistence: {
      readWindowWorkspace: () =>
        input.workspace === undefined
          ? undefined
          : { workspace: input.workspace, aggregateVersion: 0 as never },
      readChatThread: (threadId: ChatThreadId) =>
        input.chat !== undefined && String(input.chat.id) === String(threadId)
          ? input.chat
          : undefined,
      readCodeThread: (threadId: CodeThreadId) =>
        input.code !== undefined && String(input.code.id) === String(threadId)
          ? input.code
          : undefined,
      readProject: () => input.project,
    } as never,
    workThreadProjection: {
      read: (threadId: WorkThreadId) =>
        input.work !== undefined && String(input.work.id) === String(threadId)
          ? input.work
          : undefined,
    } as never,
    parentThreadId: parentId(input.parentThreadId),
    windowId: String(ids.window),
    codeSessionAuthority: input.authority ?? new CodeSessionAuthorityStore(),
  });
}

describe("authorizeAgentRunCreation", () => {
  it("refuses creation when the window has no persisted workspace", () => {
    expect(
      authorize({
        parentThreadId: String(ids.chat),
        chat: chatThread(),
      }),
    ).toBeUndefined();
  });

  it("authorizes a Chat parent that the window layout currently contains", () => {
    const thread = chatThread();
    const workspace = withSurface(
      defaultWindowWorkspace(ids.window),
      "chat",
      decodeWorkspaceTab({
        kind: "chat-thread",
        id: ids.tab,
        threadId: thread.id,
        mode: "chat",
        title: thread.title,
      }),
    );
    const facts = authorize({
      workspace,
      chat: thread,
      parentThreadId: String(thread.id),
    });
    expect(facts?.parentMode).toBe("chat");
    expect(facts?.workspaceParent).toEqual({ threadId: String(thread.id), mode: "chat" });
    expect(facts?.liveAuthority.executionPolicy).toBe("plan");
  });

  it("refuses a Chat parent that is not in the window layout", () => {
    expect(
      authorize({
        workspace: defaultWindowWorkspace(ids.window),
        chat: chatThread(),
        parentThreadId: String(ids.chat),
      }),
    ).toBeUndefined();
  });

  it("authorizes a Work parent bound to the window's Work Project", () => {
    const thread = workThread();
    const workspace = withSurface(
      {
        ...defaultWindowWorkspace(ids.window),
        contextByMode: {
          ...defaultWindowWorkspace(ids.window).contextByMode,
          work: contextKeyForProject("work", LOCAL_HOST_ID, ids.project, "/home/folder"),
        },
      },
      "work",
      decodeWorkspaceTab({
        kind: "work-thread",
        id: ids.tab,
        threadId: thread.id,
        mode: "work",
        title: thread.title,
      }),
    );
    const facts = authorize({
      workspace,
      work: thread,
      project: workProject(),
      parentThreadId: String(thread.id),
    });
    expect(facts?.parentMode).toBe("work");
    expect(facts?.workspaceParent).toMatchObject({
      mode: "work",
      projectId: String(ids.project),
      canonicalRoot: "/home/folder",
    });
  });

  it("refuses a Work parent on a different Project than the window", () => {
    const thread = workThread();
    const workspace = withSurface(
      {
        ...defaultWindowWorkspace(ids.window),
        contextByMode: {
          ...defaultWindowWorkspace(ids.window).contextByMode,
          work: contextKeyForProject("work", LOCAL_HOST_ID, ids.otherProject, "/other"),
        },
      },
      "work",
      decodeWorkspaceTab({
        kind: "work-thread",
        id: ids.tab,
        threadId: thread.id,
        mode: "work",
        title: thread.title,
      }),
    );
    expect(
      authorize({
        workspace,
        work: thread,
        project: workProject(),
        parentThreadId: String(thread.id),
      }),
    ).toBeUndefined();
  });

  it("authorizes a Code parent when the window is bound to that Code Project", () => {
    const thread = codeThread();
    const workspace = withSurface(
      {
        ...defaultWindowWorkspace(ids.window),
        contextByMode: {
          ...defaultWindowWorkspace(ids.window).contextByMode,
          code: contextKeyForProject("code", LOCAL_HOST_ID, ids.project, "/repo"),
        },
      },
      "code",
      decodeWorkspaceTab({
        kind: "code-overview",
        id: ids.tab,
        threadId: thread.id,
        mode: "code",
        title: thread.title,
      }),
    );
    const facts = authorize({
      workspace,
      code: thread,
      parentThreadId: String(thread.id),
    });
    expect(facts?.parentMode).toBe("code");
    expect(facts?.liveAuthority.shell).toBe(true);
    expect(facts?.workspaceParent).toMatchObject({
      mode: "code",
      projectId: String(ids.project),
    });
  });

  it("refuses a Code parent for a window bound to a different Code Project", () => {
    const thread = codeThread();
    const workspace = withSurface(
      {
        ...defaultWindowWorkspace(ids.window),
        contextByMode: {
          ...defaultWindowWorkspace(ids.window).contextByMode,
          code: contextKeyForProject("code", LOCAL_HOST_ID, ids.otherProject, "/other"),
        },
      },
      "code",
      decodeWorkspaceTab({
        kind: "code-overview",
        id: ids.tab,
        threadId: thread.id,
        mode: "code",
        title: thread.title,
      }),
    );
    expect(
      authorize({
        workspace,
        code: thread,
        parentThreadId: String(thread.id),
      }),
    ).toBeUndefined();
  });

  it("uses the window's live Code execution policy for the child grant", () => {
    const thread = codeThread("plan");
    const workspace = withSurface(
      {
        ...defaultWindowWorkspace(ids.window),
        contextByMode: {
          ...defaultWindowWorkspace(ids.window).contextByMode,
          code: contextKeyForProject("code", LOCAL_HOST_ID, ids.project, "/repo"),
        },
      },
      "code",
      decodeWorkspaceTab({
        kind: "code-overview",
        id: ids.tab,
        threadId: thread.id,
        mode: "code",
        title: thread.title,
      }),
    );
    const facts = authorize({
      workspace,
      code: thread,
      parentThreadId: String(thread.id),
    });
    expect(facts?.liveAuthority).toMatchObject({
      executionPolicy: "plan",
      shell: false,
      git: false,
      network: false,
    });
  });
});

describe("layoutContainsAgentRunThread", () => {
  it("finds a thread in a split layout on the matching host", () => {
    const first = paneWith(
      decodeWorkspaceTab({
        kind: "welcome",
        id: ids.tab,
        mode: "code",
        title: "Welcome",
      }),
    );
    const second = paneWith(
      decodeWorkspaceTab({
        kind: "code-overview",
        id: decodeWorkspaceTabId("00000000-0000-4000-8000-00000000a073"),
        threadId: ids.code,
        mode: "code",
        title: "Implement",
        hostId: LOCAL_HOST_ID,
      }),
    );
    const split: WorkspaceLayoutNode = {
      kind: "split",
      nodeId: decodeLayoutNodeId("00000000-0000-4000-8000-00000000a074"),
      orientation: "horizontal",
      ratio: 0.5,
      first,
      second,
    };
    expect(layoutContainsAgentRunThread(split, String(ids.code), String(LOCAL_HOST_ID))).toBe(true);
    expect(layoutContainsAgentRunThread(split, String(ids.code), "other-host")).toBe(false);
  });
});
