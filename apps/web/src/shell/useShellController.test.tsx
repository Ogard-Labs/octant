import {
  decodeCanvasId,
  decodeChatThreadId,
  decodeWorkThreadId,
  decodeCodeThreadId,
  decodeHostId,
  decodeProjectId,
  decodeSideChatSidecar,
  decodeWindowId,
  decodeWorkspaceTabId,
  type CodeThreadId,
  type ShellBootstrap,
  type ShellCommand,
  type ShellCommandResult,
  type WorkspaceLayoutNode,
  type WorkspaceTab,
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

type PaneNode = Extract<WorkspaceLayoutNode, { kind: "pane" }>;

function firstPane(layout: WorkspaceLayoutNode): PaneNode {
  return layout.kind === "pane" ? layout : firstPane(layout.first);
}

function panes(layout: WorkspaceLayoutNode): Array<PaneNode> {
  return layout.kind === "pane" ? [layout] : [...panes(layout.first), ...panes(layout.second)];
}

/**
 * A sidebar drag or drop mints a fresh surface object every time, exactly like
 * the production drag source; the workspace deduplicates by surface identity,
 * never by object or tab id.
 */
function mintedCodeThreadSurface(threadId: CodeThreadId, title: string): WorkspaceTab {
  return {
    kind: "code-overview",
    id: decodeWorkspaceTabId(crypto.randomUUID()),
    mode: "code",
    threadId,
    title,
  };
}

describe("useShellController", () => {
  it("switches to Chat and reuses the pane already showing a repeated thread selection", async () => {
    const server = statefulClient();
    const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000898");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openChatThread(threadId, "Planning"));
    await act(async () => result.current.openChatThread(threadId, "Planning"));

    expect(result.current.workspace?.activeMode).toBe("chat");
    const threadPanes = panes(result.current.workspace!.layouts.chat).filter(
      (pane) => pane.surface.kind === "chat-thread" && pane.surface.threadId === threadId,
    );
    expect(threadPanes).toHaveLength(1);
    expect(String(result.current.workspace!.activePaneIds.chat)).toBe(
      String(threadPanes[0]!.paneId),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "chat" }),
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

  it("opens one mode-matched Project surface and reuses its pane on repeat selection", async () => {
    const server = statefulClient();
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openProject(projectId, "code", "Octant"));
    await act(async () => result.current.openProject(projectId, "code", "Octant"));

    const projectPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "project" && pane.surface.projectId === projectId,
    );
    expect(projectPanes).toHaveLength(1);
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(projectPanes[0]!.paneId),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "code" }),
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
          kind: "switch-project-surface",
          mode: "code",
          surface: { kind: "project", projectId: nextProjectId },
        },
      });
      const operation =
        command.kind === "apply-workspace-operation" ? command.operation : undefined;
      if (operation === undefined || operation.kind !== "switch-project-surface") {
        throw new Error("expected Project switch");
      }
      const pane = firstPane(bootstrap.workspace.layouts.code);
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
            code: { ...pane, surface: operation.surface },
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

  it("opens Side Chat about the pane's visible thread in that same pane", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");

    await act(async () => result.current.openCodeThread(threadId, "Release notes"));
    const threadPane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.openSurface("side-chat"));

    const sideChatPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "side-chat",
    );
    expect(sideChatPanes).toHaveLength(1);
    expect(String(sideChatPanes[0]!.paneId)).toBe(String(threadPane.paneId));
    expect(sideChatPanes[0]!.surface).toMatchObject({
      sourceThreadId: String(threadId),
      title: "Side Chat about Release notes",
    });
  });

  it("refuses Side Chat when the pane shows no thread to ask about", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openSurface("side-chat"));

    expect(
      panes(result.current.workspace!.layouts.code).filter(
        (pane) => pane.surface.kind === "side-chat",
      ),
    ).toEqual([]);
    expect(result.current.errorMessage).toBe("This surface is not available here.");
  });

  it("records the sidecar identity on a Side Chat surface opened from the launcher", async () => {
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
    const opened = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "side-chat",
    );
    expect(opened[0]!.surface).toMatchObject({ sourceThreadId: String(threadId) });
    expect(opened[0]!.surface).not.toHaveProperty("sidecarThreadId");

    await act(async () => result.current.openSideChat(sidecar));

    const sideChatPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "side-chat",
    );
    expect(sideChatPanes).toHaveLength(1);
    expect(sideChatPanes[0]!.surface).toMatchObject({
      sourceThreadId: String(threadId),
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
    });
  });

  it("opens the Side Chat surface a host-resolved sidecar names", async () => {
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

    const sideChatPanes = panes(result.current.workspace!.layouts.work).filter(
      (pane) => pane.surface.kind === "side-chat",
    );
    expect(sideChatPanes).toHaveLength(1);
    expect(sideChatPanes[0]!.surface).toMatchObject({
      mode: "work",
      sourceThreadId: "00000000-0000-4000-8000-000000000895",
      sidecarThreadId: "00000000-0000-4000-8000-000000000201",
    });
  });

  it("routes every Local servers Open through one Browser pane, keeping the newest context", async () => {
    // With one surface per pane, a second classified local server takes over
    // the Browser pane rather than opening beside the first; only the same
    // context reopened reuses the committed surface.
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
    // The same context reopened is still the same surface.
    await act(async () => {
      adopted.push(await result.current.openSurface("browser", undefined, second));
    });

    // Each Open is told, from the committed workspace at that moment, that its
    // context had a pane — and so a close path.
    expect(adopted).toEqual([true, true, true]);

    const browserPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "browser",
    );
    expect(browserPanes).toHaveLength(1);
    expect((browserPanes[0]!.surface as { contextId?: string }).contextId).toBe(second);
  });

  it("reports a Local servers Open whose Browser surface could not be committed", async () => {
    // A rejected workspace mutation is recovered rather than thrown, so the
    // caller that minted the context has only this answer to go on: reporting
    // success here would strand the context with no pane to close it.
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
      panes(result.current.workspace!.layouts.code).filter(
        (pane) => pane.surface.kind === "browser",
      ),
    ).toHaveLength(0);
  });

  it("activates the existing Browser pane instead of creating duplicates", async () => {
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
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(threadId, "Browser QA"));
    await act(async () => result.current.openSurface("browser"));
    await act(async () => result.current.openSurface("browser"));

    const browserPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "browser",
    );
    expect(browserPanes).toHaveLength(1);
    // The surface stays bound to the thread that owned the pane it replaced.
    expect(browserPanes[0]!.surface).toMatchObject({ kind: "browser", threadId });
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "code" }),
      }),
    );
  });

  it("adds a fresh Terminal in a split beside the current Code tab", async () => {
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
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000895");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(threadId, "Terminal QA"));
    const sourcePane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.openSurfaceInSplit("terminal", sourcePane.paneId));

    const terminalPane = panes(result.current.workspace!.layouts.code).find(
      (pane) => pane.surface.kind === "code-terminal",
    );
    expect(terminalPane?.surface).toMatchObject({
      kind: "code-terminal",
      threadId,
      title: "Terminal",
    });
    expect(
      terminalPane?.surface.kind === "code-terminal" ? terminalPane.surface.terminalId : undefined,
    ).toBeDefined();
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "split-pane", mode: "code" }),
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

  it("lets a Project-scoped draft take over the pane the generic draft occupied", async () => {
    // Open replaces: drafts for different Projects are different surfaces, and
    // the newer one lands in the pane the person is working in rather than
    // spawning a second view.
    const server = statefulClient();
    const projectId = decodeProjectId("00000000-0000-4000-8000-000000000897");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openDraftThread("code"));
    expect(result.current.announcement).toBe("New Code thread draft opened.");
    await act(async () => result.current.openDraftThread("code", projectId));

    const draftPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "draft-thread",
    );
    expect(draftPanes).toHaveLength(1);
    expect(draftPanes[0]!.surface).toMatchObject({ kind: "draft-thread", mode: "code", projectId });
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(draftPanes[0]!.paneId),
    );
  });

  it("rebinds the draft's pane when the thread minted from it opens", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000893");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openDraftThread("code"));
    const draftPane = firstPane(result.current.workspace!.layouts.code);
    expect(draftPane.surface.kind).toBe("draft-thread");

    await act(async () => result.current.openCodeThread(threadId, "Minted thread"));

    const allPanes = panes(result.current.workspace!.layouts.code);
    expect(allPanes).toHaveLength(1);
    expect(String(allPanes[0]!.paneId)).toBe(String(draftPane.paneId));
    expect(allPanes[0]!.surface).toMatchObject({ kind: "code-overview", threadId });
    expect(allPanes.filter((pane) => pane.surface.kind === "draft-thread")).toEqual([]);
  });

  it("opens one durable preview pane per opaque target and reuses it on repeat selection", async () => {
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
    const previewPanes = panes(result.current.workspace!.layouts.work).filter(
      (pane) => pane.surface.kind === "preview" && pane.surface.targetId === targetId,
    );
    expect(previewPanes).toHaveLength(1);
    expect(String(result.current.workspace!.activePaneIds.work)).toBe(
      String(previewPanes[0]!.paneId),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "work" }),
      }),
    );
  });

  it("opens one durable canvas pane per canvasId and reuses it on repeat selection", async () => {
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
    const canvasPanes = panes(result.current.workspace!.layouts.chat).filter(
      (pane) => pane.surface.kind === "canvas" && pane.surface.canvasId === canvasId,
    );
    expect(canvasPanes).toHaveLength(1);
    expect(canvasPanes[0]!.surface).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });
    expect(String(result.current.workspace!.activePaneIds.chat)).toBe(
      String(canvasPanes[0]!.paneId),
    );
  });

  it("closes a canvas pane and restores canvas identity after bootstrap reload", async () => {
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
    const openedPane = firstPane(result.current.workspace!.layouts.chat);
    expect(openedPane.surface).toMatchObject({ kind: "canvas", canvasId });

    let closed!: boolean;
    await act(async () => {
      closed = await result.current.closePane(openedPane.paneId);
    });
    expect(closed).toBe(true);
    expect(
      panes(result.current.workspace!.layouts.chat).filter(
        (pane) => pane.surface.kind === "canvas",
      ),
    ).toHaveLength(0);

    await act(async () => result.current.openCanvas(canvasInput));
    expect(firstPane(result.current.workspace!.layouts.chat).surface).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });

    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const restoredPane = firstPane(result.current.workspace!.layouts.chat);
    expect(restoredPane.surface).toMatchObject({
      kind: "canvas",
      title: "Quarterly summary",
      canvasId,
      projectId,
    });
    expect(String(result.current.workspace!.activePaneIds.chat)).toBe(String(restoredPane.paneId));
    expect(server.client.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("keeps a canvas visible by splitting before the next thread opens", async () => {
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
    const canvasPane = firstPane(result.current.workspace!.layouts.chat);
    await act(async () => result.current.splitPane(canvasPane.paneId, "vertical"));
    // The new pane is now the active one, so the next open lands there and the
    // canvas keeps its view instead of being replaced.
    await act(async () => result.current.openChatThread(threadId, "Planning"));

    const layout = result.current.workspace!.layouts.chat;
    expect(layout.kind).toBe("split");
    const allPanes = panes(layout);
    expect(allPanes).toHaveLength(2);
    expect(
      allPanes.some((pane) => pane.surface.kind === "canvas" && pane.surface.canvasId === canvasId),
    ).toBe(true);
    expect(
      allPanes.some(
        (pane) => pane.surface.kind === "chat-thread" && pane.surface.threadId === threadId,
      ),
    ).toBe(true);
  });

  it("denies a cross-Project canvas drop without journaling an operation", async () => {
    const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000900");
    const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
    const base = workBootstrap();
    const workLayout = base.workspace.layouts.work;
    const codeLayout = base.workspace.layouts.code;
    if (workLayout.kind !== "pane" || codeLayout.kind !== "pane") {
      throw new Error("expected panes");
    }
    const canvasSurface = {
      kind: "canvas" as const,
      id: workLayout.surface.id,
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
          work: { ...workLayout, surface: canvasSurface },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const executeCallsBefore = server.execute.mock.calls.length;
    await act(async () =>
      result.current.dropSurface(canvasSurface, {
        kind: "center",
        targetPaneId: codeLayout.paneId,
      }),
    );

    expect(server.execute.mock.calls.length).toBe(executeCallsBefore);
    expect(result.current.announcement).toMatch(/different Project/i);
  });

  it("denies a cross-Project preview drop without journaling an operation", async () => {
    const workProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const codeProjectId = decodeProjectId("00000000-0000-4000-8000-000000000900");
    const base = workBootstrap();
    const workLayout = base.workspace.layouts.work;
    const codeLayout = base.workspace.layouts.code;
    if (workLayout.kind !== "pane" || codeLayout.kind !== "pane") {
      throw new Error("expected panes");
    }
    const previewSurface = {
      kind: "preview" as const,
      id: workLayout.surface.id,
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
          work: { ...workLayout, surface: previewSurface },
        },
      },
    };
    const server = statefulClient(bootstrap);
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const executeCallsBefore = server.execute.mock.calls.length;
    await act(async () =>
      result.current.dropSurface(previewSurface, {
        kind: "center",
        targetPaneId: codeLayout.paneId,
      }),
    );

    // The drop is denied at the renderer: no new execute call was journaled
    // and an honest denial announcement is surfaced.
    expect(server.execute.mock.calls.length).toBe(executeCallsBefore);
    expect(result.current.announcement).toMatch(/different Project/i);
  });

  it("switches to Code and reuses one overview pane per thread", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000897");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(threadId, "Controller foundation"));
    await act(async () => result.current.openCodeThread(threadId, "Controller foundation"));

    expect(result.current.workspace?.activeMode).toBe("code");
    const overviewPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "code-overview" && pane.surface.threadId === threadId,
    );
    expect(overviewPanes).toHaveLength(1);
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(overviewPanes[0]!.paneId),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "code" }),
      }),
    );
  });

  it("treats a Code thread as one surface regardless of reporting host", async () => {
    // A Code thread is the same conversation whichever host reports it, so a
    // second selection carrying a different host activates the visible pane
    // instead of minting a second view of the same thread.
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

    const overviewPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "code-overview" && pane.surface.threadId === threadId,
    );
    expect(overviewPanes).toHaveLength(1);
    // Activation keeps the committed surface, so the first host binding stays.
    expect(overviewPanes[0]!.surface).toMatchObject({ hostId: "local" });
    expect(result.current.announcement).toBe("Duplicate title selected.");
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
      panes(result.current.workspace!.layouts.code).some(
        (pane) =>
          pane.surface.kind === "code-overview" && pane.surface.title === "Other Project Code",
      ),
    ).toBe(false);
  });

  it("switches to Work and reuses one thread pane per thread", async () => {
    const server = statefulClient();
    const threadId = decodeWorkThreadId("00000000-0000-4000-8000-000000000896");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openWorkThread(threadId, "Draft brief"));
    await act(async () => result.current.openWorkThread(threadId, "Draft brief"));

    expect(result.current.workspace?.activeMode).toBe("work");
    const threadPanes = panes(result.current.workspace!.layouts.work).filter(
      (pane) => pane.surface.kind === "work-thread" && pane.surface.threadId === threadId,
    );
    expect(threadPanes).toHaveLength(1);
    expect(String(result.current.workspace!.activePaneIds.work)).toBe(
      String(threadPanes[0]!.paneId),
    );
    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface", mode: "work" }),
      }),
    );
  });

  it("replaces the pane when the same Work thread arrives from a different host", async () => {
    // Work threads keep their host qualification: the hostless Project row is
    // a different surface from the host-qualified one, so it opens fresh — in
    // the same pane, because open replaces — rather than activating the
    // host-qualified view.
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

    const threadPanes = panes(result.current.workspace!.layouts.work).filter(
      (pane) => pane.surface.kind === "work-thread" && pane.surface.threadId === threadId,
    );
    expect(threadPanes).toHaveLength(1);
    expect(threadPanes[0]!.surface).not.toHaveProperty("hostId");
    expect(result.current.announcement).toBe("Project thread opened.");
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
          kind: "open-surface",
          mode: "code",
          surface: expect.objectContaining({ kind: "code-file", relativePath: "src/index.ts" }),
        }),
      }),
    );
  });

  it("gives a second terminal its own pane and a title that tells it from the first", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000898");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () =>
      result.current.openCodeSurface({ kind: "code-terminal", threadId, title: "Terminal" }),
    );
    const firstTerminalPane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(firstTerminalPane.paneId, "horizontal"));
    await act(async () =>
      result.current.openCodeSurface({
        kind: "code-terminal",
        threadId,
        title: "Terminal",
        terminalId: "80000000-0000-4000-8000-000000000042" as never,
      }),
    );
    // Reopening the surface without naming a terminal returns to the first
    // pane rather than starting a third shell.
    await act(async () =>
      result.current.openCodeSurface({ kind: "code-terminal", threadId, title: "Terminal" }),
    );

    const terminalPanes = panes(result.current.workspace!.layouts.code).filter(
      (pane) => pane.surface.kind === "code-terminal",
    );
    expect(terminalPanes.map((pane) => pane.surface.title)).toEqual(["Terminal", "Terminal 2"]);
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(firstTerminalPane.paneId),
    );
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
    const chatPane = firstPane(result.current.workspace!.layouts.chat);
    await act(async () => result.current.splitPane(chatPane.paneId, "horizontal"));
    const chatLayout = result.current.workspace!.layouts.chat;
    expect(chatLayout.kind).toBe("split");
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

  it("splits, resizes, focuses, opens, closes, and resets panes", async () => {
    const server = statefulClient();
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000890");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const original = firstPane(result.current.workspace!.layouts.code);

    await act(async () => result.current.splitPane(original.paneId, "horizontal"));
    let layout = result.current.workspace!.layouts.code;
    expect(layout.kind).toBe("split");
    const split = layout.kind === "split" ? layout : undefined;
    expect(split).toBeDefined();
    const [left, right] = panes(layout);
    expect(String(left!.paneId)).toBe(String(original.paneId));
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(String(right!.paneId));
    expect(result.current.announcement).toBe("Horizontal split created.");

    const storedRatio = split!.ratio;
    act(() => result.current.previewSplitResize(split!.nodeId, 0.7));
    expect(result.current.workspace!.layouts.code).toHaveProperty("ratio", storedRatio);
    expect(result.current.presentedLayout).toHaveProperty("ratio", 0.7);
    await act(async () => result.current.commitSplitResize(split!.nodeId, 0.7));
    expect(result.current.workspace!.layouts.code).toHaveProperty("ratio", 0.7);

    await act(async () => result.current.focusPane(right!.paneId));
    expect(String(result.current.workspace?.focusedPaneId)).toBe(String(right!.paneId));
    expect(result.current.announcement).toMatch(/focused/i);
    await act(async () => result.current.clearFocus());
    expect(result.current.workspace?.focusedPaneId).toBeUndefined();

    // The thread lands in the active pane — the new one the split created.
    await act(async () => result.current.openCodeThread(threadId, "Gesture thread"));
    layout = result.current.workspace!.layouts.code;
    const threadPane = panes(layout).find((pane) => pane.surface.kind === "code-overview");
    expect(String(threadPane?.paneId)).toBe(String(right!.paneId));

    // Clicking the welcome pane is not an activation worth journaling.
    const executeCalls = server.execute.mock.calls.length;
    await act(async () => result.current.activatePane(left!.paneId));
    expect(server.execute.mock.calls.length).toBe(executeCalls);

    let closed!: boolean;
    await act(async () => {
      closed = await result.current.closePane(right!.paneId);
    });
    expect(closed).toBe(true);
    expect(result.current.announcement).toBe("Pane closed.");
    expect(result.current.workspace!.layouts.code).toEqual(original);

    await act(async () => result.current.resetActiveLayout());
    expect(result.current.workspace!.layouts.code).toEqual(original);
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(String(original.paneId));
  });

  it("makes a clicked pane the one the window is about without journaling no-ops", async () => {
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const firstThreadPane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(firstThreadPane.paneId, "horizontal"));
    await act(async () => result.current.openCodeThread(secondThreadId, "Second"));
    expect(String(result.current.workspace!.activePaneIds.code)).not.toBe(
      String(firstThreadPane.paneId),
    );

    await act(async () => result.current.activatePane(firstThreadPane.paneId));

    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(firstThreadPane.paneId),
    );
    expect(result.current.announcement).toBe("First selected.");
    // The activation reuses the pane's own committed surface object.
    const activated = firstPane(result.current.workspace!.layouts.code);
    expect(String(activated.surface.id)).toBe(String(firstThreadPane.surface.id));

    // Activating the already-active pane changes nothing worth journaling.
    const executeCalls = server.execute.mock.calls.length;
    await act(async () => result.current.activatePane(firstThreadPane.paneId));
    expect(server.execute.mock.calls.length).toBe(executeCalls);
  });

  it("re-targets the active pane when focus moves to another pane", async () => {
    // The right utility dock and thread controllers resolve against the active
    // pane, so focusing a pane must re-target it in the same committed write —
    // one source of truth, not a renderer-side shadow of it.
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const firstThreadPane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(firstThreadPane.paneId, "horizontal"));
    await act(async () => result.current.openCodeThread(secondThreadId, "Second"));

    await act(async () => result.current.focusPane(firstThreadPane.paneId));

    expect(String(result.current.workspace?.focusedPaneId)).toBe(String(firstThreadPane.paneId));
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(
      String(firstThreadPane.paneId),
    );
  });

  it("reports nothing lost when closing the last welcome pane", async () => {
    const server = statefulClient();
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const welcomePane = firstPane(result.current.workspace!.layouts.code);
    expect(welcomePane.surface.kind).toBe("welcome");

    let closed!: boolean;
    await act(async () => {
      closed = await result.current.closePane(welcomePane.paneId);
    });

    // Closing the last pane recreates the mode's default welcome pane, so the
    // surface never actually left the workspace.
    expect(closed).toBe(false);
    const remaining = result.current.workspace!.layouts.code;
    expect(remaining.kind).toBe("pane");
    expect(firstPane(remaining).surface.kind).toBe("welcome");
  });

  it("presents the authoritative active pane at narrow widths without rewriting the split tree", async () => {
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

    const source = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(source.paneId, "horizontal"));
    const authoritative = result.current.workspace!.layouts.code;
    const activePaneId = result.current.workspace!.activePaneIds.code;

    expect(authoritative.kind).toBe("split");
    expect(result.current.presentedLayout).toMatchObject({ kind: "pane", paneId: activePaneId });
    expect(result.current.workspace!.layouts.code).toBe(authoritative);
  });

  it("translates an edge drop into one atomic split and a center drop into a replace", async () => {
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const thirdThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000893");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const targetPane = firstPane(result.current.workspace!.layouts.code);

    await act(async () =>
      result.current.dropSurface(mintedCodeThreadSurface(secondThreadId, "Second"), {
        kind: "edge",
        targetPaneId: targetPane.paneId,
        edge: "top",
      }),
    );

    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "split-pane",
          targetPaneId: targetPane.paneId,
          orientation: "vertical",
          placement: "before",
          ratio: 0.5,
        }),
      }),
    );
    expect(result.current.workspace!.layouts.code).toMatchObject({
      kind: "split",
      orientation: "vertical",
      first: { kind: "pane", surface: { threadId: secondThreadId } },
      second: { kind: "pane", paneId: targetPane.paneId },
    });

    await act(async () =>
      result.current.dropSurface(mintedCodeThreadSurface(thirdThreadId, "Third"), {
        kind: "center",
        targetPaneId: targetPane.paneId,
      }),
    );

    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "replace-pane-surface",
          paneId: targetPane.paneId,
        }),
      }),
    );
    const replaced = panes(result.current.workspace!.layouts.code).find(
      (pane) => String(pane.paneId) === String(targetPane.paneId),
    );
    expect(replaced?.surface).toMatchObject({ kind: "code-overview", threadId: thirdThreadId });
  });

  it("moves an already-visible surface instead of duplicating it on a center drop", async () => {
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const sourcePane = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(sourcePane.paneId, "horizontal"));
    await act(async () => result.current.openCodeThread(secondThreadId, "Second"));
    const targetPane = panes(result.current.workspace!.layouts.code).find(
      (pane) => pane.surface.kind === "code-overview" && pane.surface.threadId === secondThreadId,
    );
    expect(targetPane).toBeDefined();

    // The sidebar drag mints a fresh surface object; the workspace recognizes
    // the thread as already visible and moves its pane instead of duplicating.
    await act(async () =>
      result.current.dropSurface(mintedCodeThreadSurface(firstThreadId, "First"), {
        kind: "center",
        targetPaneId: targetPane!.paneId,
      }),
    );

    const layout = result.current.workspace!.layouts.code;
    expect(layout.kind).toBe("pane");
    const survivor = firstPane(layout);
    expect(String(survivor.paneId)).toBe(String(targetPane!.paneId));
    expect(survivor.surface).toMatchObject({ kind: "code-overview", threadId: firstThreadId });
    // The committed surface object survives the move, so per-surface state
    // keyed on its id does too.
    expect(String(survivor.surface.id)).toBe(String(sourcePane.surface.id));
    expect(result.current.announcement).toBe("First moved.");
  });

  it("pins a sidebar thread into a new split pane beside the active one", async () => {
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const original = firstPane(result.current.workspace!.layouts.code);
    await act(async () =>
      result.current.pinInPane(mintedCodeThreadSurface(secondThreadId, "Second")),
    );

    expect(server.client.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "split-pane",
          targetPaneId: original.paneId,
          orientation: "horizontal",
          placement: "after",
        }),
      }),
    );
    const layout = result.current.workspace!.layouts.code;
    expect(layout).toMatchObject({
      kind: "split",
      orientation: "horizontal",
      first: { kind: "pane", paneId: original.paneId, surface: { threadId: firstThreadId } },
      second: { kind: "pane", surface: { threadId: secondThreadId } },
    });
    const pinned = panes(layout).find(
      (pane) => pane.surface.kind === "code-overview" && pane.surface.threadId === secondThreadId,
    );
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(String(pinned?.paneId));
    expect(result.current.announcement).toBe("Second pinned.");
  });

  it("activates a visible thread instead of minting a second pane when pinning it", async () => {
    const server = statefulClient();
    const firstThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000891");
    const secondThreadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000892");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(firstThreadId, "First"));
    const firstPaneId = firstPane(result.current.workspace!.layouts.code).paneId;
    await act(async () =>
      result.current.pinInPane(mintedCodeThreadSurface(secondThreadId, "Second")),
    );
    expect(panes(result.current.workspace!.layouts.code)).toHaveLength(2);

    await act(async () =>
      result.current.pinInPane(mintedCodeThreadSurface(firstThreadId, "First")),
    );

    expect(panes(result.current.workspace!.layouts.code)).toHaveLength(2);
    expect(String(result.current.workspace!.activePaneIds.code)).toBe(String(firstPaneId));
    expect(result.current.announcement).toBe("First selected.");
  });

  it("refuses a cross-Project pin and offers a new window instead of mixing authority", async () => {
    const currentProjectId = decodeProjectId("00000000-0000-4000-8000-000000000898");
    const nextProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000897");
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
        throw new Error("cross-Project pin must not journal a layout mutation");
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
      result.current.pinInPane(mintedCodeThreadSurface(threadId, "Other Project"), nextProjectId),
    );

    expect(client.execute).not.toHaveBeenCalled();
    expect(result.current.crossContextOffer).toMatchObject({
      newWindowProjectId: nextProjectId,
    });
    expect(result.current.workspace?.layouts.code.kind).toBe("pane");
    await act(async () => result.current.openCrossContextInNewWindow());
    expect(openInNewWindow).toHaveBeenCalledWith({
      kind: "project-thread",
      projectId: nextProjectId,
      mode: "code",
      threadId: String(threadId),
    });
  });

  it("refuses a cross-Project drop instead of switching this window's Project", async () => {
    const currentProjectId = decodeProjectId("00000000-0000-4000-8000-000000000898");
    const nextProjectId = decodeProjectId("00000000-0000-4000-8000-000000000899");
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000897");
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
        throw new Error("cross-Project drop must not journal a layout mutation");
      }),
    };
    const { result } = renderHook(() =>
      useShellController({ client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const targetPane = firstPane(result.current.workspace!.layouts.code);

    await act(async () =>
      result.current.dropSurface(
        mintedCodeThreadSurface(threadId, "Other Project"),
        { kind: "edge", targetPaneId: targetPane.paneId, edge: "right" },
        nextProjectId,
      ),
    );

    expect(client.execute).not.toHaveBeenCalled();
    expect(result.current.crossContextOffer?.message).toMatch(/different Project/);
    expect(result.current.workspace?.layouts.code.kind).toBe("pane");
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
      const client = createShellClient({
        baseUrl: "http://127.0.0.1:13773",
        fetch,
        windowCapability: "A".repeat(43),
      });
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
    const chatPane = firstPane(result.current.workspace!.layouts.chat);
    let newer!: Promise<void>;
    act(() => {
      newer = result.current.splitPane(chatPane.paneId, "horizontal");
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
    const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000898");
    const { result } = renderHook(() =>
      useShellController({ client: server.client, serverUrl: "http://127.0.0.1:13773", windowId }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.openCodeThread(threadId, "Planning"));
    await act(async () => result.current.openCodeThread(threadId, "Planning"));
    const firstSequence = result.current.announcementSequence;
    expect(result.current.announcement).toBe("Planning selected.");
    await act(async () => result.current.openCodeThread(threadId, "Planning"));

    expect(result.current.announcement).toBe("Planning selected.");
    expect(result.current.announcementSequence).toBeGreaterThan(firstSequence);
  });

  it("filters implemented settings, resets native bounds, and presents one pane narrowly without changing the tree", async () => {
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
    const source = firstPane(result.current.workspace!.layouts.code);
    await act(async () => result.current.splitPane(source.paneId, "vertical"));
    expect(result.current.workspace!.layouts.code.kind).toBe("split");

    rerender({ narrow: true });
    expect(result.current.presentedLayout?.kind).toBe("pane");
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
