import {
  decodeCanvasId,
  decodeChatThreadId,
  decodeWorkThreadId,
  decodeCodeThreadId,
  decodeHostId,
  decodeProjectId,
  decodeSideChatSidecar,
  decodeWindowId,
  type ShellBootstrap,
  type ShellCommand,
  type ShellCommandResult,
  type WorkspaceLayoutNode,
} from "@octant/contracts";
import {
  decodePreviewHostId,
  decodePreviewOpaqueRef,
  decodePreviewTargetId,
} from "@octant/contracts/previews";
import {
  applyWorkspaceOperation,
  buildSurfaceCatalog,
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  reconcileWorkspaceWithSettings,
} from "@octant/domain/shell-policy";
import { createShellClient, type ShellClient } from "@octant/client-runtime";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useShellController } from "./useShellController";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000601");

function initialBootstrap(): ShellBootstrap {
  return {
    settings: defaultShellSettings(),
    workspace: defaultWindowWorkspace(windowId),
    availableSurfaces: buildSurfaceCatalog(defaultWindowWorkspace(windowId).contextByMode),
    connectionStatus: "connected",
    settingsVersion: 0 as ShellBootstrap["settingsVersion"],
    workspaceVersion: 0 as ShellBootstrap["workspaceVersion"],
    environmentPresentation: defaultEnvironmentPresentationState(),
    presentationVersion: 0 as ShellBootstrap["presentationVersion"],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function codeBootstrap(): ShellBootstrap {
  const bootstrap = initialBootstrap();
  return {
    ...bootstrap,
    workspace: { ...bootstrap.workspace, activeMode: "code" },
  };
}

function workBootstrap(): ShellBootstrap {
  const bootstrap = initialBootstrap();
  return {
    ...bootstrap,
    workspace: { ...bootstrap.workspace, activeMode: "work" },
  };
}

function statefulClient(initial = codeBootstrap()) {
  let state = initial;
  const bootstrap = vi.fn(async () => state);
  const execute = vi.fn(async (command: ShellCommand): Promise<ShellCommandResult> => {
    if (command.kind === "replace-settings") {
      state = {
        ...state,
        settings: command.settings,
        settingsVersion: (state.settingsVersion + 1) as ShellBootstrap["settingsVersion"],
      };
      return {
        kind: "settings-replaced",
        settings: state.settings,
        version: state.settingsVersion,
      };
    }
    if (command.kind === "set-environment-presentation") {
      state = {
        ...state,
        environmentPresentation: command.presentation,
        presentationVersion: (state.presentationVersion +
          1) as ShellBootstrap["presentationVersion"],
      };
      return {
        kind: "environment-presentation-replaced",
        presentation: state.environmentPresentation,
        version: state.presentationVersion,
      };
    }
    const reconciled = reconcileWorkspaceWithSettings(state.workspace, state.settings);
    const workspace = applyWorkspaceOperation(reconciled, command.operation);
    state = {
      ...state,
      workspace,
      workspaceVersion: (state.workspaceVersion + 1) as ShellBootstrap["workspaceVersion"],
    };
    return { kind: "workspace-replaced", workspace, version: state.workspaceVersion };
  });
  const client: ShellClient = { bootstrap, execute };
  return { client, execute, bootstrap, read: () => state };
}

function firstGroup(layout: WorkspaceLayoutNode): Extract<WorkspaceLayoutNode, { kind: "group" }> {
  return layout.kind === "group" ? layout : firstGroup(layout.first);
}

function groups(
  layout: WorkspaceLayoutNode,
): Array<Extract<WorkspaceLayoutNode, { kind: "group" }>> {
  return layout.kind === "group" ? [layout] : [...groups(layout.first), ...groups(layout.second)];
}

describe("useShellController", () => {
  it("switches to Chat and opens one durable thread tab on repeated selection", async () => {
    const server = statefulClient();
    const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000898");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openChatThread(threadId, "Planning"));
    await act(async () => result.current.openChatThread(threadId, "Planning"));

    expect(result.current.workspace?.activeMode).toBe("chat");
    const group = firstGroup(result.current.workspace!.layouts.chat);
    const tabs = group.tabs.filter(
      (tab) => tab.kind === "chat-thread" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "chat" }),
      }),
    );
  });

  it("reports failure when opening a Chat thread cannot be committed", async () => {
    const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000897");
    const client: ShellClient = {
      bootstrap: vi.fn(async () => initialBootstrap()),
      execute: vi.fn(async () => {
        throw { category: "invalid", message: "Workspace persistence failed." };
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let opened!: boolean;
    await act(async () => {
      opened = await result.current.openChatThread(threadId, "Planning");
    });

    expect(opened).toBe(false);
    expect(result.current.workspace?.activeMode).toBe("chat");
    expect(result.current.errorMessage).toBe("Workspace persistence failed.");
  });

  it("opens one mode-matched Project tab and activates it on repeat selection", async () => {
    const server = statefulClient();
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openProject(projectId, "code", "Octant"));
    await act(async () => result.current.openProject(projectId, "code", "Octant"));

    const group = firstGroup(result.current.workspace!.layouts.code);
    const tabs = group.tabs.filter((tab) => tab.kind === "project" && tab.projectId === projectId);
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "code" }),
      }),
    );
  });

  it("switches a bound window to another Project instead of offering a new window", async () => {
    const currentProjectId = decodeProjectId("00000000-0000-4000-8000-000000000898");
    const nextProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const initial = codeBootstrap();
    const bootstrap: ShellBootstrap = {
      ...initial,
      workspace: {
        ...initial.workspace,
        contextByMode: {
          ...initial.workspace.contextByMode,
          code: {
            ...initial.workspace.contextByMode.code,
            projectId: currentProjectId,
            boundRoot: "/current",
          },
        },
      },
    };
    const execute = vi.fn(async (command: ShellCommand): Promise<ShellCommandResult> => {
      expect(command).toMatchObject({
        kind: "apply-workspace-operation",
        operation: {
          kind: "switch-project-tab",
          mode: "code",
          tab: { kind: "project", projectId: nextProjectId },
        },
      });
      const operation =
        command.kind === "apply-workspace-operation" ? command.operation : undefined;
      if (operation === undefined || operation.kind !== "switch-project-tab") {
        throw new Error("expected Project switch");
      }
      const group = firstGroup(bootstrap.workspace.layouts.code);
      return {
        kind: "workspace-replaced",
        workspace: {
          ...bootstrap.workspace,
          contextByMode: {
            ...bootstrap.workspace.contextByMode,
            code: {
              ...bootstrap.workspace.contextByMode.code,
              projectId: nextProjectId,
              boundRoot: "/next",
            },
          },
          layouts: {
            ...bootstrap.workspace.layouts,
            code: { ...group, tabs: [operation.tab], activeTabId: operation.tab.id },
          },
        },
        version: 1 as ShellBootstrap["workspaceVersion"],
      };
    });
    const client: ShellClient = { bootstrap: vi.fn(async () => bootstrap), execute };
    const { result } = renderHook(() =>
      useShellController({
        client,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openProject(nextProjectId, "code", "Next Project"));

    expect(result.current.workspace?.contextByMode.code.projectId).toBe(nextProjectId);
    expect(result.current.crossContextOffer).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("opens Side Chat about the group's active thread and reuses that tab", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");

    await act(async () => result.current.openCodeThread(threadId, "Release notes"));
    await act(async () => result.current.openSurface("side-chat"));
    await act(async () => result.current.openSurface("side-chat"));

    const sideChatTabs = groups(result.current.workspace!.layouts.code).flatMap((group) =>
      group.tabs.filter((tab) => tab.kind === "side-chat"),
    );
    expect(sideChatTabs).toHaveLength(1);
    expect(sideChatTabs[0]).toMatchObject({
      sourceThreadId: String(threadId),
      title: "Side Chat about Release notes",
    });
  });

  it("refuses Side Chat when the group has no thread to ask about", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openSurface("side-chat"));

    expect(
      groups(result.current.workspace!.layouts.code).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === "side-chat"),
      ),
    ).toEqual([]);
    expect(result.current.errorMessage).toBe("This surface is not available here.");
  });

  it("records the sidecar identity on a Side Chat tab opened from the launcher", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");
    const sidecar = decodeSideChatSidecar({
      sourceThreadId: String(threadId),
      sourceMode: "code",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z",
    });

    await act(async () => result.current.openCodeThread(threadId, "Release notes"));
    await act(async () => result.current.openSurface("side-chat"));
    expect(
      groups(result.current.workspace!.layouts.code).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === "side-chat"),
      )[0],
    ).toMatchObject({ sourceThreadId: String(threadId) });
    expect(
      groups(result.current.workspace!.layouts.code).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === "side-chat"),
      )[0],
    ).not.toHaveProperty("sidecarThreadId");

    await act(async () => result.current.openSideChat(sidecar));

    const sideChatTabs = groups(result.current.workspace!.layouts.code).flatMap((group) =>
      group.tabs.filter((tab) => tab.kind === "side-chat"),
    );
    expect(sideChatTabs).toHaveLength(1);
    expect(sideChatTabs[0]).toMatchObject({
      sourceThreadId: String(threadId),
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
    });
  });

  it("opens the Side Chat tab a host-resolved sidecar names", async () => {
    const server = statefulClient(workBootstrap());
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const sidecar = decodeSideChatSidecar({
      sourceThreadId: "00000000-0000-4000-8000-000000000895",
      sourceMode: "work",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
      title: "Side Chat about Release notes",
      createdAt: "2026-08-14T10:00:00.000Z",
    });

    await act(async () => result.current.openSideChat(sidecar));
    await act(async () => result.current.openSideChat(sidecar));

    const sideChatTabs = groups(result.current.workspace!.layouts.work).flatMap((group) =>
      group.tabs.filter((tab) => tab.kind === "side-chat"),
    );
    expect(sideChatTabs).toHaveLength(1);
    expect(sideChatTabs[0]).toMatchObject({
      mode: "work",
      sourceThreadId: "00000000-0000-4000-8000-000000000895",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
    });
  });

  it("gives each Local servers Open its own Browser tab", async () => {
    // A second classified local server opens beside the first rather
    // than reusing — and so replacing — the tab the first one is showing.
    const initial = codeBootstrap();
    const server = statefulClient({
      ...initial,
      workspace: {
        ...initial.workspace,
        contextByMode: {
          ...initial.workspace.contextByMode,
          code: {
            ...initial.workspace.contextByMode.code,
            projectId: decodeProjectId("00000000-0000-4000-8000-000000000896"),
            boundRoot: "/repo",
          },
        },
      },
    });
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.openCodeThread(
        decodeCodeThreadId("00000000-0000-4000-8000-000000000895"),
        "Local servers owner",
      ),
    );

    const first = "60000000-0000-4000-8000-000000000001" as never;
    const second = "60000000-0000-4000-8000-000000000002" as never;
    const adopted: boolean[] = [];
    await act(async () => {
      adopted.push(await result.current.openSurface("browser", undefined, first));
    });
    await act(async () => {
      adopted.push(await result.current.openSurface("browser", undefined, second));
    });
    // The same context reopened is still the same tab.
    await act(async () => {
      adopted.push(await result.current.openSurface("browser", undefined, second));
    });

    // Each Open is told, from the committed workspace, that its context now has
    // a tab — and so a close path.
    expect(adopted).toEqual([true, true, true]);

    const browserTabs = groups(result.current.workspace!.layouts.code).flatMap((group) =>
      group.tabs.filter((tab) => tab.kind === "browser"),
    );
    expect(browserTabs).toHaveLength(2);
    expect(browserTabs.map((tab) => (tab as { contextId?: string }).contextId)).toEqual([
      first,
      second,
    ]);
  });

  it("reports a Local servers Open whose Browser tab could not be committed", async () => {
    // A rejected workspace mutation is recovered rather than thrown, so the
    // caller that minted the context has only this answer to go on: reporting
    // success here would strand the context with no tab to close it.
    const initial = codeBootstrap();
    const server = statefulClient({
      ...initial,
      workspace: {
        ...initial.workspace,
        contextByMode: {
          ...initial.workspace.contextByMode,
          code: {
            ...initial.workspace.contextByMode.code,
            projectId: decodeProjectId("00000000-0000-4000-8000-000000000896"),
            boundRoot: "/repo",
          },
        },
      },
    });
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.openCodeThread(
        decodeCodeThreadId("00000000-0000-4000-8000-000000000895"),
        "Local servers owner",
      ),
    );

    server.execute.mockImplementationOnce(async () => {
      throw { category: "invalid", message: "Workspace persistence failed." };
    });
    let adopted!: boolean;
    await act(async () => {
      adopted = await result.current.openSurface(
        "browser",
        undefined,
        "60000000-0000-4000-8000-000000000001" as never,
      );
    });

    expect(adopted).toBe(false);
    expect(
      groups(result.current.workspace!.layouts.code).flatMap((group) =>
        group.tabs.filter((tab) => tab.kind === "browser"),
      ),
    ).toHaveLength(0);
  });

  it("activates an existing Browser tab instead of creating duplicates", async () => {
    const initial = codeBootstrap();
    const server = statefulClient({
      ...initial,
      workspace: {
        ...initial.workspace,
        contextByMode: {
          ...initial.workspace.contextByMode,
          code: {
            ...initial.workspace.contextByMode.code,
            projectId: decodeProjectId("00000000-0000-4000-8000-000000000896"),
            boundRoot: "/repo",
          },
        },
      },
    });
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCodeThread(
        decodeCodeThreadId("00000000-0000-4000-8000-000000000895"),
        "Browser QA",
      ),
    );
    await act(async () => result.current.openSurface("browser"));
    await act(async () => result.current.openSurface("browser"));

    const browserTabs = groups(result.current.workspace!.layouts.code).flatMap((group) =>
      group.tabs.filter((tab) => tab.kind === "browser"),
    );
    expect(browserTabs).toHaveLength(1);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "code" }),
      }),
    );
  });

  it("offers a real Project window when a thread selection crosses workspace authority", async () => {
    const currentProjectId = decodeProjectId("00000000-0000-4000-8000-000000000898");
    const nextProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const base = codeBootstrap();
    const bootstrap: ShellBootstrap = {
      ...base,
      workspace: {
        ...base.workspace,
        contextByMode: {
          ...base.workspace.contextByMode,
          code: {
            ...base.workspace.contextByMode.code,
            projectId: currentProjectId,
            boundRoot: "/current",
          },
        },
      },
    };
    const client: ShellClient = {
      bootstrap: vi.fn(async () => bootstrap),
      execute: vi.fn(async () => {
        throw {
          category: "cross-context",
          message:
            "This surface belongs to a different Project. Open it in a new window to keep its authority.",
        };
      }),
    };
    const openInNewWindow = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useShellController({
        client,
        nativeHost: { resetBounds: vi.fn(), openInNewWindow },
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCodeThread(
        decodeCodeThreadId("00000000-0000-4000-8000-000000000897"),
        "Terminal QA",
        undefined,
        nextProjectId,
      ),
    );

    await waitFor(() =>
      expect(result.current.crossContextOffer).toMatchObject({
        newWindowProjectId: nextProjectId,
      }),
    );
    expect(result.current.canOpenCrossContextInNewWindow).toBe(true);

    await act(async () => result.current.openCrossContextInNewWindow());

    expect(openInNewWindow).toHaveBeenCalledWith({
      kind: "project-thread",
      projectId: nextProjectId,
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000897",
    });
    expect(result.current.crossContextOffer).toBeUndefined();
  });

  it("preserves unrelated drafts when opening a Project-scoped draft", async () => {
    const server = statefulClient();
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000897");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openDraftThread("code"));
    await act(async () => result.current.openDraftThread("code", projectId));

    const group = firstGroup(result.current.workspace!.layouts.code);
    const drafts = group.tabs.filter((tab) => tab.kind === "draft-thread");
    expect(drafts).toHaveLength(2);
    const genericDraft = drafts.find((tab) => tab.projectId === undefined);
    const projectDraft = drafts.find((tab) => tab.projectId === projectId);
    expect(genericDraft).toMatchObject({ kind: "draft-thread", mode: "code" });
    expect(projectDraft).toMatchObject({ kind: "draft-thread", mode: "code", projectId });
    expect(group.activeTabId).toBe(projectDraft!.id);
  });

  it("opens one durable preview tab per opaque target and activates it on repeat selection", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const base = workBootstrap();
    const workContext = base.workspace.contextByMode.work;
    const bootstrap: ShellBootstrap = {
      ...base,
      workspace: {
        ...base.workspace,
        contextByMode: {
          ...base.workspace.contextByMode,
          work: { ...workContext, projectId, boundRoot: "/home/folder" },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const targetId = decodePreviewTargetId("11111111-2222-4333-8444-555555555555");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const previewInput = {
      mode: "work" as const,
      title: "report.pdf",
      targetId,
      projectId,
      hostId: decodePreviewHostId("22222222-3333-4444-8555-666666666666"),
      targetKind: "file" as const,
      opaqueRef: decodePreviewOpaqueRef("opaque-token"),
      displayName: "report.pdf",
    };
    await act(async () => result.current.openPreview(previewInput));
    await act(async () => result.current.openPreview(previewInput));

    expect(result.current.workspace?.activeMode).toBe("work");
    const group = firstGroup(result.current.workspace!.layouts.work);
    const tabs = group.tabs.filter((tab) => tab.kind === "preview" && tab.targetId === targetId);
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "work" }),
      }),
    );
  });

  it("opens one durable canvas tab per canvasId and activates it on repeat selection", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const bootstrap: ShellBootstrap = {
      ...initialBootstrap(),
      workspace: {
        ...initialBootstrap().workspace,
        activeMode: "chat",
        contextByMode: {
          ...initialBootstrap().workspace.contextByMode,
          chat: {
            ...initialBootstrap().workspace.contextByMode.chat,
            projectId,
            boundRoot: null,
          },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const canvasInput = {
      mode: "chat" as const,
      title: "Quarterly summary",
      canvasId,
      projectId,
    };
    await act(async () => result.current.openCanvas(canvasInput));
    await act(async () => result.current.openCanvas(canvasInput));

    expect(result.current.workspace?.activeMode).toBe("chat");
    const group = firstGroup(result.current.workspace!.layouts.chat);
    const tabs = group.tabs.filter((tab) => tab.kind === "canvas" && tab.canvasId === canvasId);
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(tabs[0]).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "chat" }),
      }),
    );
  });

  it("closes a canvas tab and restores canvas identity after bootstrap reload", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const bootstrap: ShellBootstrap = {
      ...initialBootstrap(),
      workspace: {
        ...initialBootstrap().workspace,
        activeMode: "chat",
        contextByMode: {
          ...initialBootstrap().workspace.contextByMode,
          chat: {
            ...initialBootstrap().workspace.contextByMode.chat,
            projectId,
            boundRoot: null,
          },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const canvasInput = {
      mode: "chat" as const,
      title: "Quarterly summary",
      canvasId,
      projectId,
    };
    await act(async () => result.current.openCanvas(canvasInput));
    const openedGroup = firstGroup(result.current.workspace!.layouts.chat);
    const canvasTab = openedGroup.tabs.find(
      (tab) => tab.kind === "canvas" && tab.canvasId === canvasId,
    );
    expect(canvasTab).toBeDefined();

    await act(async () => result.current.closeTab(openedGroup.groupId, canvasTab!.id));
    expect(
      firstGroup(result.current.workspace!.layouts.chat).tabs.filter(
        (tab) => tab.kind === "canvas" && tab.canvasId === canvasId,
      ),
    ).toHaveLength(0);

    await act(async () => result.current.openCanvas(canvasInput));
    const reopenedGroup = firstGroup(result.current.workspace!.layouts.chat);
    const reopenedTab = reopenedGroup.tabs.find(
      (tab) => tab.kind === "canvas" && tab.canvasId === canvasId,
    );
    expect(reopenedTab).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });

    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const reloadedGroup = firstGroup(result.current.workspace!.layouts.chat);
    const restoredTab = reloadedGroup.tabs.find(
      (tab) => tab.kind === "canvas" && tab.canvasId === canvasId,
    );
    expect(restoredTab).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });
    expect(reloadedGroup.activeTabId).toBe(restoredTab?.id);
    expect(server.client.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("pins a canvas tab, persists presentation order, and restores pin after reload", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const bootstrap: ShellBootstrap = {
      ...initialBootstrap(),
      workspace: {
        ...initialBootstrap().workspace,
        activeMode: "chat",
        contextByMode: {
          ...initialBootstrap().workspace.contextByMode,
          chat: {
            ...initialBootstrap().workspace.contextByMode.chat,
            projectId,
            boundRoot: null,
          },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCanvas({
        mode: "chat",
        title: "Quarterly summary",
        canvasId,
        projectId,
      }),
    );
    const group = firstGroup(result.current.workspace!.layouts.chat);
    const canvasTab = group.tabs.find((tab) => tab.kind === "canvas");
    expect(canvasTab).toBeDefined();

    await act(async () => result.current.toggleCanvasTabPin(group.groupId, canvasTab!));
    const pinnedGroup = firstGroup(result.current.workspace!.layouts.chat);
    const pinnedTab = pinnedGroup.tabs.find((tab) => tab.id === canvasTab!.id);
    expect(pinnedTab?.kind).toBe("canvas");
    if (pinnedTab?.kind !== "canvas") throw new Error("expected canvas");
    expect(pinnedTab.pinned).toBe(true);
    expect(pinnedGroup.tabs[0]?.id).toBe(canvasTab!.id);
    expect(result.current.announcement).toMatch(/pinned/i);

    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const reloadedGroup = firstGroup(result.current.workspace!.layouts.chat);
    const restoredTab = reloadedGroup.tabs.find((tab) => tab.id === canvasTab!.id);
    expect(restoredTab?.kind).toBe("canvas");
    if (restoredTab?.kind !== "canvas") throw new Error("expected canvas");
    expect(restoredTab.pinned).toBe(true);
    expect(reloadedGroup.tabs[0]?.id).toBe(canvasTab!.id);
  });

  it("reorders and splits canvas tabs through the split workspace tree", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000898");
    const bootstrap: ShellBootstrap = {
      ...initialBootstrap(),
      workspace: {
        ...initialBootstrap().workspace,
        activeMode: "chat",
        contextByMode: {
          ...initialBootstrap().workspace.contextByMode,
          chat: {
            ...initialBootstrap().workspace.contextByMode.chat,
            projectId,
            boundRoot: null,
          },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCanvas({
        mode: "chat",
        title: "Quarterly summary",
        canvasId,
        projectId,
      }),
    );
    await act(async () => result.current.openChatThread(threadId, "Planning"));

    const group = firstGroup(result.current.workspace!.layouts.chat);
    const canvasTab = group.tabs.find((tab) => tab.kind === "canvas");
    const threadTab = group.tabs.find((tab) => tab.kind === "chat-thread");
    expect(canvasTab).toBeDefined();
    expect(threadTab).toBeDefined();

    await act(async () =>
      result.current.reorderTab(group.groupId, canvasTab!.id, group.tabs.length - 1),
    );
    const reordered = firstGroup(result.current.workspace!.layouts.chat);
    expect(reordered.tabs[reordered.tabs.length - 1]?.id).toBe(canvasTab!.id);

    await act(async () =>
      result.current.splitGroup(group.groupId, canvasTab!.id, "vertical", "after"),
    );
    const splitLayout = result.current.workspace!.layouts.chat;
    expect(splitLayout.kind).toBe("split");
    const splitGroups = groups(splitLayout);
    expect(splitGroups).toHaveLength(2);
    expect(
      splitGroups.some((candidate) =>
        candidate.tabs.some((tab) => tab.kind === "canvas" && tab.canvasId === canvasId),
      ),
    ).toBe(true);
  });

  it("denies a cross-Project canvas tab drop without journaling a move", async () => {
    const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000900");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const base = workBootstrap();
    const workLayout = base.workspace.layouts.work;
    const codeLayout = base.workspace.layouts.code;
    if (workLayout.kind !== "group" || codeLayout.kind !== "group") {
      throw new Error("expected groups");
    }
    const canvasTab = {
      kind: "canvas" as const,
      id: workLayout.tabs[0]!.id,
      mode: "work" as const,
      title: "Quarterly summary",
      canvasId,
      projectId: workProjectId,
    };
    const bootstrap: ShellBootstrap = {
      ...base,
      workspace: {
        ...base.workspace,
        contextByMode: {
          ...base.workspace.contextByMode,
          work: {
            ...base.workspace.contextByMode.work,
            projectId: workProjectId,
            boundRoot: "/home/folder",
          },
          code: {
            ...base.workspace.contextByMode.code,
            projectId: codeProjectId,
            boundRoot: "/repo",
          },
        },
        layouts: {
          ...base.workspace.layouts,
          work: { ...workLayout, tabs: [canvasTab], activeTabId: canvasTab.id },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const codeGroup = firstGroup(result.current.workspace!.layouts.code);
    const executeCallsBefore = server.execute.mock.calls.length;
    await act(async () =>
      result.current.dropTab({
        kind: "center",
        sourceGroupId: firstGroup(result.current.workspace!.layouts.work).groupId,
        targetGroupId: codeGroup.groupId,
        tabId: canvasTab.id,
        index: 0,
      }),
    );

    expect(server.execute.mock.calls.length).toBe(executeCallsBefore);
    expect(result.current.announcement).toMatch(/different Project/i);
  });

  it("denies a cross-Project preview tab drop without journaling a move", async () => {
    const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000900");
    const base = workBootstrap();
    const workLayout = base.workspace.layouts.work;
    const codeLayout = base.workspace.layouts.code;
    if (workLayout.kind !== "group" || codeLayout.kind !== "group") {
      throw new Error("expected groups");
    }
    const previewTab = {
      kind: "preview" as const,
      id: workLayout.tabs[0]!.id,
      mode: "work" as const,
      title: "report.pdf",
      targetId: decodePreviewTargetId("11111111-2222-4333-8444-555555555555"),
      projectId: workProjectId,
      hostId: decodePreviewHostId("22222222-3333-4444-8555-666666666666"),
      targetKind: "file" as const,
      opaqueRef: decodePreviewOpaqueRef("opaque-token"),
      displayName: "report.pdf",
    };
    const bootstrap: ShellBootstrap = {
      ...base,
      workspace: {
        ...base.workspace,
        contextByMode: {
          ...base.workspace.contextByMode,
          work: {
            ...base.workspace.contextByMode.work,
            projectId: workProjectId,
            boundRoot: "/home/folder",
          },
          code: {
            ...base.workspace.contextByMode.code,
            projectId: codeProjectId,
            boundRoot: "/repo",
          },
        },
        layouts: {
          ...base.workspace.layouts,
          work: { ...workLayout, tabs: [previewTab], activeTabId: previewTab.id },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const codeGroup = firstGroup(result.current.workspace!.layouts.code);
    const executeCallsBefore = server.execute.mock.calls.length;
    await act(async () =>
      result.current.dropTab({
        kind: "center",
        sourceGroupId: firstGroup(result.current.workspace!.layouts.work).groupId,
        targetGroupId: codeGroup.groupId,
        tabId: previewTab.id,
        index: 0,
      }),
    );

    // The drop is denied at the renderer: no new execute call was journaled
    // and an honest denial announcement is surfaced.
    expect(server.execute.mock.calls.length).toBe(executeCallsBefore);
    expect(result.current.announcement).toMatch(/different Project/i);
  });

  it("switches to Code and opens one durable overview tab per thread", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000897");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(threadId, "Controller foundation"));
    await act(async () => result.current.openCodeThread(threadId, "Controller foundation"));

    expect(result.current.workspace?.activeMode).toBe("code");
    const group = firstGroup(result.current.workspace!.layouts.code);
    const tabs = group.tabs.filter(
      (tab) => tab.kind === "code-overview" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "code" }),
      }),
    );
  });

  it("keeps identical thread IDs from different hosts in distinct durable tabs", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000899");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCodeThread(threadId, "Duplicate title", decodeHostId("local")),
    );
    await act(async () =>
      result.current.openCodeThread(threadId, "Duplicate title", decodeHostId("host-b")),
    );

    const tabs = firstGroup(result.current.workspace!.layouts.code).tabs.filter(
      (tab) => tab.kind === "code-overview" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => ("hostId" in tab ? tab.hostId : undefined))).toEqual([
      "local",
      "host-b",
    ]);
  });

  it("does not retarget a host-qualified Code tab when opening a hostless Project thread", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCodeThread(threadId, "Remote host thread", decodeHostId("host-b")),
    );
    await act(async () => result.current.openCodeThread(threadId, "Project thread"));

    const group = firstGroup(result.current.workspace!.layouts.code);
    const tabs = group.tabs.filter(
      (tab) => tab.kind === "code-overview" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => ("hostId" in tab ? tab.hostId : undefined))).toEqual([
      "host-b",
      undefined,
    ]);
    expect(group.activeTabId).toBe(tabs[1]!.id);
  });

  it("preserves a Project-bound context when opening Code returns a cross-context offer", async () => {
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000894");
    const base = codeBootstrap();
    const bootstrap: ShellBootstrap = {
      ...base,
      workspace: {
        ...base.workspace,
        contextByMode: {
          ...base.workspace.contextByMode,
          code: {
            ...base.workspace.contextByMode.code,
            projectId,
            boundRoot: "/repo",
          },
        },
      },
    };
    const client: ShellClient = {
      bootstrap: vi.fn(async () => bootstrap),
      execute: vi.fn(async () => {
        throw {
          category: "cross-context",
          message: "That thread belongs to another Project. Open it in a new window.",
        };
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openCodeThread(
        decodeCodeThreadId("00000000-0000-4000-8000-000000000895"),
        "Other Project Code",
        decodeHostId("local"),
      ),
    );

    expect(result.current.crossContextOffer?.message).toContain("another Project");
    expect(result.current.workspace?.contextByMode.code).toMatchObject({
      projectId,
      boundRoot: "/repo",
    });
    expect(
      firstGroup(result.current.workspace!.layouts.code).tabs.some(
        (tab) => tab.kind === "code-overview" && tab.title === "Other Project Code",
      ),
    ).toBe(false);
  });

  it("switches to Work and opens one durable thread tab per thread", async () => {
    const server = statefulClient();
    const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000896");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openWorkThread(threadId, "Draft brief"));
    await act(async () => result.current.openWorkThread(threadId, "Draft brief"));

    expect(result.current.workspace?.activeMode).toBe("work");
    const group = firstGroup(result.current.workspace!.layouts.work);
    const tabs = group.tabs.filter(
      (tab) => tab.kind === "work-thread" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(1);
    expect(group.activeTabId).toBe(tabs[0]!.id);
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "activate-tab", mode: "work" }),
      }),
    );
  });

  it("does not retarget a host-qualified Work tab when opening a hostless Project thread", async () => {
    const server = statefulClient(workBootstrap());
    const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000894");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () =>
      result.current.openWorkThread(threadId, "Remote host thread", decodeHostId("host-b")),
    );
    await act(async () => result.current.openWorkThread(threadId, "Project thread"));

    const group = firstGroup(result.current.workspace!.layouts.work);
    const tabs = group.tabs.filter(
      (tab) => tab.kind === "work-thread" && tab.threadId === threadId,
    );
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => ("hostId" in tab ? tab.hostId : undefined))).toEqual([
      "host-b",
      undefined,
    ]);
    expect(group.activeTabId).toBe(tabs[1]!.id);
  });

  it("binds a Browser surface to the active owning thread", async () => {
    const initial = codeBootstrap();
    const server = statefulClient({
      ...initial,
      workspace: {
        ...initial.workspace,
        contextByMode: {
          ...initial.workspace.contextByMode,
          code: {
            ...initial.workspace.contextByMode.code,
            projectId: decodeProjectId("00000000-0000-4000-8000-000000000894"),
            boundRoot: "/repo",
          },
        },
      },
    });
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.openCodeThread(threadId, "Browser owner"));
    await act(async () => result.current.openSurface("browser"));

    const codeGroups = groups(result.current.workspace!.layouts.code);
    const browserGroup = codeGroups.find((group) =>
      group.tabs.some((tab) => tab.kind === "browser"),
    );
    expect(codeGroups).toHaveLength(2);
    expect(browserGroup?.tabs).toEqual([expect.objectContaining({ kind: "browser", threadId })]);
    expect(result.current.workspace!.layouts.code).toMatchObject({
      kind: "split",
      orientation: "horizontal",
    });
  });

  it("opens reviewed Code evidence through the authoritative workspace command path", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000897");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.openCodeSurface({
        kind: "code-file",
        threadId,
        title: "src/index.ts",
        relativePath: "src/index.ts" as never,
      }),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          mode: "code",
          tab: expect.objectContaining({ kind: "code-file", relativePath: "src/index.ts" }),
        }),
      }),
    );
  });
  it("gives a second terminal its own tab and a title that tells it from the first", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000898");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.openCodeSurface({ kind: "code-terminal", threadId, title: "Terminal" }),
    );
    await act(async () =>
      result.current.openCodeSurface({
        kind: "code-terminal",
        threadId,
        title: "Terminal",
        terminalId: "80000000-0000-4000-8000-000000000042" as never,
      }),
    );
    // Reopening the surface without naming a terminal returns to the first tab
    // rather than starting a third shell.
    await act(async () =>
      result.current.openCodeSurface({ kind: "code-terminal", threadId, title: "Terminal" }),
    );

    const terminals = groups(result.current.workspace!.layouts.code)
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === "code-terminal");
    expect(terminals.map((tab) => tab.title)).toEqual(["Terminal", "Terminal 2"]);
  });

  it("holds loading until authoritative bootstrap completes and retries disconnection", async () => {
    const first = deferred<ShellBootstrap>();
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockImplementationOnce(() => first.promise)
        .mockRejectedValueOnce({ category: "unavailable", message: "Shell unavailable." })
        .mockResolvedValueOnce(initialBootstrap()),
      execute: vi.fn(),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );

    expect(result.current.status).toBe("loading");
    await act(async () => first.resolve(initialBootstrap()));
    expect(result.current.status).toBe("ready");

    await act(async () => result.current.retry());
    expect(result.current.status).toBe("disconnected");
    expect(result.current.errorMessage).toBe("Shell unavailable.");
    await act(async () => result.current.retry());
    expect(result.current.status).toBe("ready");
  });

  it("surfaces storage recovery without inventing shell defaults", async () => {
    const client: ShellClient = {
      bootstrap: vi.fn(async () => {
        throw { category: "recovery-required", message: "Repair storage before continuing." };
      }),
      execute: vi.fn(),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );

    await waitFor(() => expect(result.current.status).toBe("recovery-required"));
    expect(result.current.workspace).toBeUndefined();
    expect(result.current.errorMessage).toBe("Repair storage before continuing.");
  });

  it("bounds bootstrap loading, ignores a late response, and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<ShellBootstrap>();
      const client: ShellClient = { bootstrap: vi.fn(() => pending.promise), execute: vi.fn() };
      const { result, unmount } = renderHook(() =>
        useShellController({
          bootstrapTimeoutMs: 50,
          client,
          serverUrl: "http://127.0.0.1:13773",
          windowId,
        }),
      );

      expect(result.current.status).toBe("loading");
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(result.current.status).toBe("disconnected");
      expect(result.current.errorMessage).toMatch(/did not respond in time/i);

      await act(async () => pending.resolve(initialBootstrap()));
      expect(result.current.status).toBe("disconnected");
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending bootstrap timeout when unmounted", () => {
    vi.useFakeTimers();
    try {
      const client: ShellClient = {
        bootstrap: vi.fn(() => new Promise<ShellBootstrap>(() => undefined)),
        execute: vi.fn(),
      };
      const { unmount } = renderHook(() =>
        useShellController({
          bootstrapTimeoutMs: 100,
          client,
          serverUrl: "http://127.0.0.1:13773",
          windowId,
        }),
      );
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits mode fallback while preserving and restoring the disabled mode layout", async () => {
    const server = statefulClient();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.setMode("chat"));
    await act(async () => result.current.createShellTab());
    const chatLayout = result.current.workspace!.layouts.chat;
    await act(async () => result.current.updateSettings({ chatEnabled: false }));

    expect(result.current.settings?.chatEnabled).toBe(false);
    expect(result.current.workspace?.activeMode).toBe("code");
    expect(result.current.workspace?.layouts.chat).toEqual(chatLayout);
    expect(server.read().workspace.activeMode).toBe("code");

    await act(async () => result.current.updateSettings({ chatEnabled: true }));
    expect(result.current.workspace?.activeMode).toBe("code");
    expect(result.current.workspace?.layouts.chat).toEqual(chatLayout);
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it("keeps the fallback durable when the settings response is lost, then re-enabled and restarted", async () => {
    const activeChat = applyWorkspaceOperation(initialBootstrap().workspace, {
      kind: "set-active-mode",
      mode: "chat",
    });
    let durable = {
      ...initialBootstrap(),
      workspace: activeChat,
      workspaceVersion: 1 as ShellBootstrap["workspaceVersion"],
    };
    let loseSettingsResponse = true;
    const client: ShellClient = {
      bootstrap: vi.fn(async () => ({
        ...durable,
        workspace: reconcileWorkspaceWithSettings(durable.workspace, durable.settings),
      })),
      execute: vi.fn(async (command: ShellCommand): Promise<ShellCommandResult> => {
        if (command.kind === "apply-workspace-operation") {
          const workspace = applyWorkspaceOperation(durable.workspace, command.operation);
          durable = {
            ...durable,
            workspace,
            workspaceVersion: (durable.workspaceVersion + 1) as ShellBootstrap["workspaceVersion"],
          };
          return { kind: "workspace-replaced", workspace, version: durable.workspaceVersion };
        }
        if (command.kind === "set-environment-presentation") {
          durable = {
            ...durable,
            environmentPresentation: command.presentation,
            presentationVersion: (durable.presentationVersion +
              1) as ShellBootstrap["presentationVersion"],
          };
          return {
            kind: "environment-presentation-replaced",
            presentation: durable.environmentPresentation,
            version: durable.presentationVersion,
          };
        }
        durable = {
          ...durable,
          settings: command.settings,
          settingsVersion: (durable.settingsVersion + 1) as ShellBootstrap["settingsVersion"],
        };
        if (loseSettingsResponse) {
          loseSettingsResponse = false;
          throw { category: "unavailable", message: "Settings response was lost." };
        }
        return {
          kind: "settings-replaced",
          settings: durable.settings,
          version: durable.settingsVersion,
        };
      }),
    };
    const first = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(first.result.current.workspace?.activeMode).toBe("chat"));

    await act(async () => first.result.current.updateSettings({ chatEnabled: false }));
    expect(client.execute).toHaveBeenNthCalledWith(1, {
      kind: "apply-workspace-operation",
      windowId,
      expectedVersion: 1,
      operation: { kind: "set-active-mode", mode: "code" },
    });
    expect(first.result.current.settings?.chatEnabled).toBe(false);
    expect(first.result.current.workspace?.activeMode).toBe("code");

    await act(async () => first.result.current.updateSettings({ chatEnabled: true }));
    expect(first.result.current.workspace?.activeMode).toBe("code");
    first.unmount();

    const restarted = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(restarted.result.current.status).toBe("ready"));
    expect(restarted.result.current.settings?.chatEnabled).toBe(true);
    expect(restarted.result.current.workspace?.activeMode).toBe("code");
    restarted.unmount();
  });

  it("persists the mode-switcher presentation without changing mode or saved layouts", async () => {
    const server = statefulClient();
    const first = renderHook(() =>
      useShellController({
        client: server.client,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    const activeMode = first.result.current.workspace!.activeMode;
    const layouts = first.result.current.workspace!.layouts;

    await act(async () =>
      first.result.current.updateSettings({ modeSwitcherPresentation: "dropdown" }),
    );
    expect(first.result.current.settings?.modeSwitcherPresentation).toBe("dropdown");
    expect(first.result.current.workspace?.activeMode).toBe(activeMode);
    expect(first.result.current.workspace?.layouts).toEqual(layouts);
    first.unmount();

    const restarted = renderHook(() =>
      useShellController({
        client: server.client,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(restarted.result.current.status).toBe("ready"));
    expect(restarted.result.current.settings?.modeSwitcherPresentation).toBe("dropdown");
    expect(restarted.result.current.workspace?.activeMode).toBe(activeMode);
    expect(restarted.result.current.workspace?.layouts).toEqual(layouts);
    restarted.unmount();
  });

  it("persists the saved sidebar material across restart", async () => {
    const server = statefulClient();
    const first = renderHook(() =>
      useShellController({
        client: server.client,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("ready"));

    await act(async () => first.result.current.updateSettings({ sidebarMaterial: "opaque" }));
    expect(first.result.current.settings?.sidebarMaterial).toBe("opaque");
    first.unmount();

    const restarted = renderHook(() =>
      useShellController({
        client: server.client,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(restarted.result.current.status).toBe("ready"));
    expect(restarted.result.current.settings?.sidebarMaterial).toBe("opaque");
    restarted.unmount();
  });

  it("rolls an optimistic sidebar-material change back to authoritative state after rejection", async () => {
    const command = deferred<ShellCommandResult>();
    const client: ShellClient = {
      bootstrap: vi.fn(async () => initialBootstrap()),
      execute: vi.fn(() => command.promise),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let mutation!: Promise<boolean>;
    act(() => {
      mutation = result.current.updateSettings({ sidebarMaterial: "opaque" });
    });
    await waitFor(() => expect(result.current.settings?.sidebarMaterial).toBe("opaque"));
    await act(async () =>
      command.reject({ category: "invalid", message: "Sidebar material was rejected." }),
    );
    await act(async () => mutation);

    expect(result.current.settings?.sidebarMaterial).toBe("system");
    expect(result.current.errorMessage).toBe("Sidebar material was rejected.");
    expect(result.current.announcement).toMatch(/command rejected/i);
  });

  it.each([
    ["invalid", "That workspace operation is invalid."],
    ["unsupported", "That workspace operation is unsupported."],
  ] as const)(
    "keeps committed UI and announces a definite %s rejection",
    async (category, message) => {
      const client: ShellClient = {
        bootstrap: vi.fn(async () => initialBootstrap()),
        execute: vi.fn(async () => {
          throw { category, message };
        }),
      };
      const { result } = renderHook(() =>
        useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () => result.current.setMode("chat"));

      expect(client.bootstrap).toHaveBeenCalledOnce();
      expect(result.current.status).toBe("ready");
      expect(result.current.workspace?.activeMode).toBe("chat");
      expect(result.current.errorMessage).toBe(message);
      expect(result.current.announcement).toMatch(/command rejected/i);
    },
  );

  it("enters recovery state without an uncertain reload when a command requires recovery", async () => {
    const client: ShellClient = {
      bootstrap: vi.fn(async () => initialBootstrap()),
      execute: vi.fn(async () => {
        throw { category: "recovery-required", message: "Repair storage before continuing." };
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.updateSettings({ sidebarWidth: 320 }));

    expect(client.bootstrap).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("recovery-required");
    expect(result.current.errorMessage).toMatch(/repair storage/i);
    expect(result.current.announcement).toMatch(/repair storage/i);
  });

  it("opens, activates, reorders, splits, moves, resizes, focuses, closes, and resets tabs", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = firstGroup(result.current.workspace!.layouts.code);

    await act(async () => result.current.createShellTab());
    await act(async () => result.current.createShellTab());
    let group = firstGroup(result.current.workspace!.layouts.code);
    expect(group.tabs).toHaveLength(3);

    const welcomeId = group.tabs[0]!.id;
    await act(async () => result.current.activateTab(group.groupId, welcomeId));
    await act(async () => result.current.reorderTab(group.groupId, welcomeId, 2));
    group = firstGroup(result.current.workspace!.layouts.code);
    expect(group.activeTabId).toBe(welcomeId);
    expect(group.tabs[2]!.id).toBe(welcomeId);

    await act(async () => result.current.splitGroup(group.groupId, welcomeId, "horizontal"));
    let layout = result.current.workspace!.layouts.code;
    expect(layout.kind).toBe("split");
    const [left, right] = groups(layout);
    const split = layout.kind === "split" ? layout : undefined;
    expect(split).toBeDefined();
    expect(result.current.workspace!.activeGroupIds.code).toBe(right!.groupId);

    const storedRatio = split!.ratio;
    act(() => result.current.previewSplitResize(split!.nodeId, 0.7));
    expect(result.current.workspace!.layouts.code).toHaveProperty("ratio", storedRatio);
    expect(result.current.presentedLayout).toHaveProperty("ratio", 0.7);
    await act(async () => result.current.commitSplitResize(split!.nodeId, 0.7));
    expect(result.current.workspace!.layouts.code).toHaveProperty("ratio", 0.7);

    await act(async () => result.current.focusGroup(right!.groupId));
    expect(result.current.workspace?.focusedGroupId).toBe(right!.groupId);
    expect(result.current.announcement).toMatch(/focused/i);
    await act(async () => result.current.clearFocus());
    expect(result.current.workspace?.focusedGroupId).toBeUndefined();

    const movable = left!.tabs[0]!;
    await act(async () => result.current.moveTab(left!.groupId, right!.groupId, movable.id, 1));
    expect(result.current.workspace!.activeGroupIds.code).toBe(right!.groupId);
    expect(groups(result.current.workspace!.layouts.code)[1]!.tabs).toHaveLength(2);
    await act(async () => result.current.closeTab(right!.groupId, movable.id));
    expect(result.current.announcement).toMatch(/closed/i);

    await act(async () => result.current.resetActiveLayout());
    expect(result.current.workspace!.layouts.code).toEqual(original);
    expect(result.current.workspace!.activeGroupIds.code).toBe(original.groupId);
  });

  it("presents the authoritative active group at narrow widths without rewriting the split tree", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({
        client: server.client,
        isNarrow: true,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.createShellTab());
    const source = firstGroup(result.current.workspace!.layouts.code);
    const moved = source.tabs.at(-1)!;
    await act(async () => result.current.splitGroup(source.groupId, moved.id, "horizontal"));
    const authoritative = result.current.workspace!.layouts.code;
    const activeGroupId = result.current.workspace!.activeGroupIds.code;

    expect(authoritative.kind).toBe("split");
    expect(result.current.presentedLayout).toMatchObject({ kind: "group", groupId: activeGroupId });
    expect(result.current.workspace!.layouts.code).toBe(authoritative);
  });

  it("translates cross-group directional docking into one atomic operation", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.createShellTab());
    await act(async () => result.current.createShellTab());
    const initialGroup = firstGroup(result.current.workspace!.layouts.code);
    const tabId = initialGroup.tabs.at(-1)!.id;
    await act(async () => result.current.splitGroup(initialGroup.groupId, tabId, "horizontal"));
    const [target, source] = groups(result.current.workspace!.layouts.code);

    await act(async () =>
      result.current.dropTab({
        kind: "edge",
        sourceGroupId: source!.groupId,
        targetGroupId: target!.groupId,
        tabId,
        edge: "top",
      }),
    );

    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "dock-tab",
          fromGroupId: source!.groupId,
          targetGroupId: target!.groupId,
          tabId,
          orientation: "vertical",
          placement: "before",
          ratio: 0.5,
        }),
      }),
    );
    expect(result.current.workspace!.layouts.code).toMatchObject({
      kind: "split",
      orientation: "vertical",
      first: { kind: "group", tabs: [{ id: tabId }] },
      second: { kind: "group", groupId: target!.groupId },
    });
  });

  it("translates reorder, center, and same-group edge destinations through existing operations", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.createShellTab());
    await act(async () => result.current.createShellTab());
    let group = firstGroup(result.current.workspace!.layouts.code);
    const tabId = group.tabs.at(-1)!.id;
    await act(async () =>
      result.current.dropTab({
        kind: "reorder",
        sourceGroupId: group.groupId,
        targetGroupId: group.groupId,
        tabId,
        index: 0,
      }),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "reorder-tab", index: 0 }),
      }),
    );

    group = firstGroup(result.current.workspace!.layouts.code);
    await act(async () =>
      result.current.dropTab({
        kind: "edge",
        sourceGroupId: group.groupId,
        targetGroupId: group.groupId,
        tabId,
        edge: "left",
      }),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "split-group",
          orientation: "horizontal",
          placement: "before",
        }),
      }),
    );

    const [source, target] = groups(result.current.workspace!.layouts.code);
    await act(async () =>
      result.current.dropTab({
        kind: "center",
        sourceGroupId: source!.groupId,
        targetGroupId: target!.groupId,
        tabId,
        index: target!.tabs.length,
      }),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: expect.objectContaining({ kind: "move-tab" }) }),
    );
  });

  it("reloads authoritative state after a conflict", async () => {
    const reload = deferred<ShellBootstrap>();
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockResolvedValueOnce(initialBootstrap())
        .mockImplementationOnce(() => reload.promise),
      execute: vi.fn(async () => {
        throw {
          category: "conflict",
          message: "Shell state changed; reload and retry.",
          expectedVersion: 0,
          actualVersion: 1,
        };
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let command!: Promise<void>;
    act(() => {
      command = result.current.setMode("chat");
    });
    await waitFor(() => expect(result.current.status).toBe("conflict-reload"));
    await act(async () => reload.resolve(initialBootstrap()));
    await act(async () => command);
    expect(result.current.status).toBe("ready");
    expect(result.current.announcement).toBe(
      "Shell state changed concurrently. Reloaded authoritative state.",
    );
  });

  it("reports a settings write the host discarded, even once the reload clears", async () => {
    const client: ShellClient = {
      bootstrap: vi.fn(async () => initialBootstrap()),
      execute: vi.fn(async () => {
        throw {
          category: "conflict",
          message: "Shell state changed; reload and retry.",
          expectedVersion: 0,
          actualVersion: 1,
        };
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let write!: Promise<boolean>;
    act(() => {
      write = result.current.updateSettings({ chatEnabled: false });
    });

    // Recovery reloads and leaves the status `ready` again, so the status
    // alone cannot tell a caller its write was thrown away. A caller whose
    // next step is durable has to be able to see that it was.
    await expect(write).resolves.toBe(false);
    expect(result.current.status).toBe("ready");
    expect(result.current.settings?.chatEnabled).toBe(true);
  });

  it.each(["workspace", "settings"] as const)(
    "reloads a committed %s mutation after a malformed success response",
    async (mutationKind) => {
      let durable = initialBootstrap();
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = String(input);
        if (url.includes("/bootstrap")) return Response.json(durable);
        const command = JSON.parse(String(init?.body)) as ShellCommand;
        if (command.kind === "apply-workspace-operation") {
          const workspace = applyWorkspaceOperation(durable.workspace, command.operation);
          durable = {
            ...durable,
            workspace,
            workspaceVersion: (durable.workspaceVersion + 1) as ShellBootstrap["workspaceVersion"],
          };
        } else if (command.kind === "set-environment-presentation") {
          durable = {
            ...durable,
            environmentPresentation: command.presentation,
            presentationVersion: (durable.presentationVersion +
              1) as ShellBootstrap["presentationVersion"],
          };
        } else {
          durable = {
            ...durable,
            settings: command.settings,
            settingsVersion: (durable.settingsVersion + 1) as ShellBootstrap["settingsVersion"],
          };
        }
        return Response.json({ committed: true });
      });
      const client = createShellClient({ baseUrl: "http://127.0.0.1:13773", fetch });
      const { result } = renderHook(() =>
        useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
      );
      await waitFor(() => expect(result.current.status).toBe("ready"));

      await act(async () =>
        mutationKind === "workspace"
          ? result.current.setMode("chat")
          : result.current.updateSettings({ sidebarWidth: 320 }),
      );

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(result.current.status).toBe("ready");
      expect(result.current.announcement).toMatch(/outcome was uncertain/i);
      if (mutationKind === "workspace") {
        expect(result.current.workspace?.activeMode).toBe("chat");
      } else {
        expect(result.current.settings?.sidebarWidth).toBe(320);
      }
    },
  );

  it("reloads conflict state before settling the next queued operation", async () => {
    const firstCommand = deferred<ShellCommandResult>();
    const secondCommand = deferred<ShellCommandResult>();
    const reload = deferred<ShellBootstrap>();
    const recovered = initialBootstrap();
    const staleWorkspace = applyWorkspaceOperation(initialBootstrap().workspace, {
      kind: "set-active-mode",
      mode: "chat",
    });
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockResolvedValueOnce(initialBootstrap())
        .mockImplementationOnce(() => reload.promise),
      execute: vi
        .fn<ShellClient["execute"]>()
        .mockImplementationOnce(() => firstCommand.promise)
        .mockImplementationOnce(() => secondCommand.promise),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let older!: Promise<void>;
    act(() => {
      older = result.current.setMode("chat");
    });
    await waitFor(() => expect(result.current.workspace?.activeMode).toBe("chat"));
    let newer!: Promise<void>;
    act(() => {
      newer = result.current.createShellTab();
    });
    expect(client.execute).toHaveBeenCalledOnce();
    await act(async () =>
      firstCommand.resolve({
        kind: "workspace-replaced",
        version: 1 as ShellBootstrap["workspaceVersion"],
        workspace: staleWorkspace,
      }),
    );
    await act(async () => older);
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(2));
    await act(async () =>
      secondCommand.reject({
        actualVersion: 2,
        category: "conflict",
        expectedVersion: 1,
        message: "Reload authoritative state.",
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("conflict-reload"));
    await act(async () => reload.resolve(recovered));
    await act(async () => newer);
    expect(result.current.workspace?.activeMode).toBe("chat");
    expect(result.current.announcement).toMatch(/reloaded authoritative state/i);
  });

  it("reloads a committed workspace after response loss before running queued settings", async () => {
    const workspaceCommand = deferred<ShellCommandResult>();
    const settingsCommand = deferred<ShellCommandResult>();
    const reload = deferred<ShellBootstrap>();
    const committedWorkspace = applyWorkspaceOperation(initialBootstrap().workspace, {
      kind: "set-active-mode",
      mode: "chat",
    });
    const recovered = {
      ...initialBootstrap(),
      workspace: committedWorkspace,
      workspaceVersion: 1 as ShellBootstrap["workspaceVersion"],
    };
    const committedSettings = { ...defaultShellSettings(), workEnabled: false };
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockResolvedValueOnce(initialBootstrap())
        .mockImplementationOnce(() => reload.promise),
      execute: vi
        .fn<ShellClient["execute"]>()
        .mockImplementationOnce(() => workspaceCommand.promise)
        .mockImplementationOnce(() => settingsCommand.promise),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let workspaceIntent!: Promise<void>;
    act(() => {
      workspaceIntent = result.current.setMode("chat");
    });
    await waitFor(() => expect(result.current.workspace?.activeMode).toBe("chat"));
    let settingsIntent!: Promise<boolean>;
    act(() => {
      settingsIntent = result.current.updateSettings({ workEnabled: false });
    });
    expect(client.execute).toHaveBeenCalledOnce();

    await act(async () =>
      workspaceCommand.reject({ category: "unavailable", message: "Response was lost." }),
    );
    await waitFor(() => expect(client.bootstrap).toHaveBeenCalledTimes(2));
    expect(client.execute).toHaveBeenCalledOnce();
    await act(async () => reload.resolve(recovered));
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(2));
    expect(client.execute).toHaveBeenLastCalledWith({
      kind: "replace-settings",
      windowId,
      expectedVersion: 0,
      settings: committedSettings,
    });
    expect(result.current.workspace?.activeMode).toBe("chat");
    expect(result.current.settings?.workEnabled).toBe(false);

    await act(async () =>
      settingsCommand.resolve({
        kind: "settings-replaced",
        settings: committedSettings,
        version: 1 as ShellBootstrap["settingsVersion"],
      }),
    );
    await act(async () => Promise.all([workspaceIntent, settingsIntent]));
    expect(result.current.status).toBe("ready");
    expect(result.current.workspace).toEqual(committedWorkspace);
    expect(result.current.settings).toEqual(committedSettings);
  });

  it("reloads committed settings after response loss before running queued workspace", async () => {
    const settingsCommand = deferred<ShellCommandResult>();
    const workspaceCommand = deferred<ShellCommandResult>();
    const reload = deferred<ShellBootstrap>();
    const committedSettings = { ...defaultShellSettings(), sidebarWidth: 320 };
    const recovered = {
      ...initialBootstrap(),
      settings: committedSettings,
      settingsVersion: 1 as ShellBootstrap["settingsVersion"],
    };
    const committedWorkspace = applyWorkspaceOperation(initialBootstrap().workspace, {
      kind: "set-active-mode",
      mode: "chat",
    });
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockResolvedValueOnce(initialBootstrap())
        .mockImplementationOnce(() => reload.promise),
      execute: vi
        .fn<ShellClient["execute"]>()
        .mockImplementationOnce(() => settingsCommand.promise)
        .mockImplementationOnce(() => workspaceCommand.promise),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let settingsIntent!: Promise<boolean>;
    act(() => {
      settingsIntent = result.current.updateSettings({ sidebarWidth: 320 });
    });
    await waitFor(() => expect(result.current.settings?.sidebarWidth).toBe(320));
    let workspaceIntent!: Promise<void>;
    act(() => {
      workspaceIntent = result.current.setMode("chat");
    });
    expect(client.execute).toHaveBeenCalledOnce();

    await act(async () =>
      settingsCommand.reject({ category: "unavailable", message: "Response was lost." }),
    );
    await waitFor(() => expect(client.bootstrap).toHaveBeenCalledTimes(2));
    expect(client.execute).toHaveBeenCalledOnce();
    await act(async () => reload.resolve(recovered));
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(2));
    expect(client.execute).toHaveBeenLastCalledWith({
      kind: "apply-workspace-operation",
      windowId,
      expectedVersion: 0,
      operation: { kind: "set-active-mode", mode: "chat" },
    });
    expect(result.current.settings?.sidebarWidth).toBe(320);
    expect(result.current.workspace?.activeMode).toBe("chat");

    await act(async () =>
      workspaceCommand.resolve({
        kind: "workspace-replaced",
        version: 1 as ShellBootstrap["workspaceVersion"],
        workspace: committedWorkspace,
      }),
    );
    await act(async () => Promise.all([settingsIntent, workspaceIntent]));
    expect(result.current.status).toBe("ready");
    expect(result.current.settings).toEqual(committedSettings);
    expect(result.current.workspace).toEqual(committedWorkspace);
  });

  it("cancels queued intents when ambiguous-command reload fails until explicit retry", async () => {
    const firstCommand = deferred<ShellCommandResult>();
    const committedSettings = { ...defaultShellSettings(), workEnabled: false };
    const client: ShellClient = {
      bootstrap: vi
        .fn<ShellClient["bootstrap"]>()
        .mockResolvedValueOnce(initialBootstrap())
        .mockRejectedValueOnce({ category: "unavailable", message: "Reload failed." })
        .mockResolvedValueOnce(initialBootstrap()),
      execute: vi
        .fn<ShellClient["execute"]>()
        .mockImplementationOnce(() => firstCommand.promise)
        .mockResolvedValueOnce({
          kind: "settings-replaced",
          settings: committedSettings,
          version: 1 as ShellBootstrap["settingsVersion"],
        }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let ambiguous!: Promise<void>;
    act(() => {
      ambiguous = result.current.setMode("chat");
    });
    let cancelled!: Promise<boolean>;
    act(() => {
      cancelled = result.current.updateSettings({ workEnabled: false });
    });
    await act(async () =>
      firstCommand.reject({ category: "unavailable", message: "Response was lost." }),
    );
    await act(async () => Promise.all([ambiguous, cancelled]));

    expect(client.bootstrap).toHaveBeenCalledTimes(2);
    expect(client.execute).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("disconnected");
    expect(result.current.announcement).toMatch(/queued shell operations were cancelled.*retry/i);

    await act(async () => result.current.retry());
    expect(result.current.status).toBe("ready");
    expect(client.execute).toHaveBeenCalledOnce();

    await act(async () => result.current.updateSettings({ workEnabled: false }));
    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(result.current.settings).toEqual(committedSettings);
  });

  it("assigns a new sequence to repeated identical announcements", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const group = firstGroup(result.current.workspace!.layouts.code);

    await act(async () => result.current.activateTab(group.groupId, group.activeTabId));
    const firstSequence = result.current.announcementSequence;
    expect(result.current.announcement).toBe("Tab activated.");
    await act(async () => result.current.activateTab(group.groupId, group.activeTabId));

    expect(result.current.announcement).toBe("Tab activated.");
    expect(result.current.announcementSequence).toBeGreaterThan(firstSequence);
  });

  it("filters implemented settings, resets native bounds, and presents one group narrowly without changing the tree", async () => {
    const server = statefulClient();
    const nativeHost = { resetBounds: vi.fn(async () => undefined) };
    const { result, rerender } = renderHook(
      ({ narrow }) =>
        useShellController({
          client: server.client,
          isNarrow: narrow,
          nativeHost,
          serverUrl: "http://127.0.0.1:13773",
          windowId,
        }),
      { initialProps: { narrow: false } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => result.current.createShellTab());
    const group = firstGroup(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitGroup(group.groupId, group.tabs[1]!.id, "vertical"));
    expect(result.current.workspace!.layouts.code.kind).toBe("split");

    rerender({ narrow: true });
    expect(result.current.presentedLayout?.kind).toBe("group");
    expect(result.current.workspace!.layouts.code.kind).toBe("split");

    for (const query of [
      "material",
      "translucent",
      "sidebar",
      "appearance",
      "  translucent   sidebar  ",
    ]) {
      act(() => result.current.setSettingsSearch(query));
      expect(result.current.visibleSettings).toContain("sidebar-material");
    }
    for (const query of ["mode", "dropdown", "navigation"]) {
      act(() => result.current.setSettingsSearch(query));
      expect(result.current.visibleSettings).toContain("mode-switcher");
    }
    await act(async () => result.current.resetNativeBounds());
    expect(nativeHost.resetBounds).toHaveBeenCalledOnce();
    expect(result.current.announcement).toMatch(/window bounds reset/i);
  });

  it("announces a native bounds reset rejection without leaving the ready shell", async () => {
    const server = statefulClient();
    const nativeHost = {
      resetBounds: vi.fn(async () => {
        throw new Error("native reset failed");
      }),
    };
    const { result } = renderHook(() =>
      useShellController({
        client: server.client,
        nativeHost,
        serverUrl: "http://127.0.0.1:13773",
        windowId,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.resetNativeBounds());

    expect(nativeHost.resetBounds).toHaveBeenCalledOnce();
    expect(result.current.announcement).toBe("Unable to reset native window bounds.");
    expect(result.current.status).toBe("ready");
  });

  it("openSettings(section, setting?) stages a pending deep link for the SettingsView to apply", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.pendingSettingsDeepLink).toBeUndefined();

    await act(async () =>
      result.current.openSettings({ section: "appearance", setting: "mode-switcher" }),
    );
    expect(result.current.settingsOpen).toBe(true);
    expect(result.current.pendingSettingsDeepLink).toEqual({
      section: "appearance",
      setting: "mode-switcher",
    });

    act(() => result.current.clearPendingSettingsDeepLink());
    expect(result.current.pendingSettingsDeepLink).toBeUndefined();
  });

  it("opens Settings as a local dedicated shell without mutating the workspace", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const workspace = result.current.workspace;
    const executeCalls = vi.mocked(server.client.execute).mock.calls.length;

    await act(async () => result.current.openSettings());
    expect(result.current.pendingSettingsDeepLink).toBeUndefined();
    expect(result.current.settingsOpen).toBe(true);
    expect(result.current.workspace).toBe(workspace);
    expect(server.client.execute).toHaveBeenCalledTimes(executeCalls);

    act(() => result.current.closeSettings());
    expect(result.current.settingsOpen).toBe(false);
    expect(result.current.workspace).toBe(workspace);
  });
});
