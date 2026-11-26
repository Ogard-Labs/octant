import {
  decodeAgentRunParentThreadId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  decodeLayoutNodeId,
  decodePaneId,
  type WindowWorkspace,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { defaultWindowWorkspace } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { createAgentRunRouteAuthority } from "./agentRuns";

const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-00000000b001"),
  fullDevice: decodeWindowId("00000000-0000-4000-8000-00000000b002"),
  restrictedDevice: decodeWindowId("00000000-0000-4000-8000-00000000b003"),
  chat: decodeChatThreadId("00000000-0000-4000-8000-00000000b010"),
  code: decodeCodeThreadId("00000000-0000-4000-8000-00000000b030"),
  project: decodeProjectId("00000000-0000-4000-8000-00000000b040"),
};

function authority(input: {
  readonly workspace?: WindowWorkspace;
  readonly projectLifecycle?: "active" | "archived";
}) {
  return createAgentRunRouteAuthority({
    persistence: {
      connection: { prepare: () => ({ get: () => undefined }) },
      readWindowWorkspace: () =>
        input.workspace === undefined ? undefined : { workspace: input.workspace },
      readChatThread: (threadId: unknown) =>
        String(threadId) === String(ids.chat) ? { id: ids.chat, projectId: undefined } : undefined,
      readCodeThread: (threadId: unknown) =>
        String(threadId) === String(ids.code)
          ? { id: ids.code, projectId: ids.project }
          : undefined,
      readProject: (projectId: unknown) =>
        String(projectId) === String(ids.project)
          ? { id: ids.project, type: "code", lifecycle: input.projectLifecycle ?? "active" }
          : undefined,
    } as never,
    workThreadProjection: { read: () => undefined } as never,
    isPairedDeviceScope: (scopeId) =>
      String(scopeId) === String(ids.fullDevice) ||
      String(scopeId) === String(ids.restrictedDevice),
    isRestrictedDeviceScope: (scopeId) => String(scopeId) === String(ids.restrictedDevice),
  });
}

function codeRun() {
  return {
    parentThreadId: decodeAgentRunParentThreadId(String(ids.code)),
    routingReceipt: { mode: "code", hostId: LOCAL_HOST_ID, projectId: ids.project },
    workspaceReceipt: { mode: "code", kind: "parent-checkout", projectId: ids.project },
  } as never;
}

function chatWorkspaceHoldingTheChat(): WindowWorkspace {
  const workspace = defaultWindowWorkspace(ids.window);
  return {
    ...workspace,
    layouts: {
      ...workspace.layouts,
      chat: {
        kind: "pane",
        nodeId: decodeLayoutNodeId("00000000-0000-4000-8000-00000000b072"),
        paneId: decodePaneId("00000000-0000-4000-8000-00000000b071"),
        surface: decodeWorkspaceTab({
          kind: "chat-thread",
          id: decodeWorkspaceTabId("00000000-0000-4000-8000-00000000b070"),
          threadId: ids.chat,
          mode: "chat",
          title: "Planning",
        }),
      },
    },
  };
}

describe("AgentRun route authority", () => {
  it("lets the person's Full device read and stop the subagents of a thread whose Project is active here", async () => {
    const routes = authority({});
    for (const threadId of [String(ids.code), String(ids.chat)]) {
      expect(
        await routes.authorizeParentThread({
          parentThreadId: decodeAgentRunParentThreadId(threadId),
          windowId: String(ids.fullDevice),
        }),
      ).toBe(true);
    }
    expect(routes.authorizeCancellation({ run: codeRun(), windowId: String(ids.fullDevice) })).toBe(
      true,
    );
  });

  it("refuses the Full device a thread whose Project is archived, and a run from another Project", async () => {
    const archived = authority({ projectLifecycle: "archived" });
    expect(
      await archived.authorizeParentThread({
        parentThreadId: decodeAgentRunParentThreadId(String(ids.code)),
        windowId: String(ids.fullDevice),
      }),
    ).toBe(false);
    expect(
      archived.authorizeCancellation({ run: codeRun(), windowId: String(ids.fullDevice) }),
    ).toBe(false);

    const otherProject = decodeProjectId("00000000-0000-4000-8000-00000000b041");
    const run = codeRun() as {
      readonly routingReceipt: Record<string, unknown>;
      readonly workspaceReceipt: Record<string, unknown>;
    };
    expect(
      authority({}).authorizeCancellation({
        run: {
          ...run,
          workspaceReceipt: { ...run.workspaceReceipt, projectId: otherProject },
        } as never,
        windowId: String(ids.fullDevice),
      }),
    ).toBe(false);
  });

  it("refuses a restricted device every subagent read and stop", async () => {
    const routes = authority({});
    expect(
      await routes.authorizeParentThread({
        parentThreadId: decodeAgentRunParentThreadId(String(ids.code)),
        windowId: String(ids.restrictedDevice),
      }),
    ).toBe(false);
    expect(
      routes.authorizeCancellation({ run: codeRun(), windowId: String(ids.restrictedDevice) }),
    ).toBe(false);
  });

  it("still admits a window only to a thread its own workspace holds", async () => {
    const parentThreadId = decodeAgentRunParentThreadId(String(ids.chat));
    expect(
      await authority({ workspace: chatWorkspaceHoldingTheChat() }).authorizeParentThread({
        parentThreadId,
        windowId: String(ids.window),
      }),
    ).toBe(true);
    expect(
      await authority({ workspace: defaultWindowWorkspace(ids.window) }).authorizeParentThread({
        parentThreadId,
        windowId: String(ids.window),
      }),
    ).toBe(false);
    // A window with no workspace on this host is not given the device's reach.
    expect(
      authority({}).authorizeCancellation({ run: codeRun(), windowId: String(ids.window) }),
    ).toBe(false);
  });
});
