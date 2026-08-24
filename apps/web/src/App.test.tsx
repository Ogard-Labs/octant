import {
  decodeWorkThread,
  type NavigatorAssistantSnapshot,
  type ShellBootstrap,
  type ProjectBootstrap,
  type ProviderRegistryCommand,
  type ProviderRegistryCommandResult,
  type UtcTimestamp,
} from "@octant/contracts";
import type { NavigatorAssistantClient } from "@octant/client-runtime/navigator-assistant-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type { ContextClient } from "@octant/client-runtime/context-client";
import { applyWorkspaceOperation } from "@octant/domain/shell-policy";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeChatCommandResult, type ChatThread } from "@octant/contracts/chat";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import type { OctantHostBridge } from "./shell/hostBridge";
import { App } from "./App";
import {
  archivedChatThread,
  bindingReceipt,
  bootstrap,
  canvasFetchPassthrough,
  chatShellBootstrap,
  chats,
  client,
  codeDraftShellBootstrap,
  codeShellBootstrap,
  codes,
  codesRecordingCreates,
  codeThreadId,
  contextClient,
  createdChatThreadId,
  credentialHostOperations,
  deferred,
  hostClient,
  observedProvider,
  oldChatThreadId,
  openAiProvider,
  openSettingsFromSidebar,
  openSidebarProject,
  otherProjectId,
  projectBootstrap,
  projectId,
  projectWindowCapability,
  projects,
  projectsWithArchivedCodeProject,
  providerModel,
  providers,
  providersWithChatOnlyModel,
  providersWithToolModel,
  readyEnvironment,
  settingsPastFirstRun,
  splitChatShellBootstrap,
  windowId,
  workDraftShellBootstrap,
  workProjectId,
  workProjects,
  workShellBootstrap,
  workThreadId,
} from "./App.test-fixtures";
import { contextFixture } from "./context/contextFixtures";

const automationGate = vi.hoisted(() => ({ enabled: false }));
vi.mock("./automation/automationCenterGate", () => ({
  get AUTOMATION_CENTER_NAVIGATION_ENABLED() {
    return automationGate.enabled;
  },
}));

afterEach(() => {
  automationGate.enabled = false;
  vi.unstubAllGlobals();
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

function navigatorAssistantClient(
  transcript: NavigatorAssistantSnapshot["transcript"] = [],
): NavigatorAssistantClient {
  let current: NavigatorAssistantSnapshot["transcript"] = [...transcript];
  const timestamp = "2026-08-15T09:00:00.000Z" as UtcTimestamp;
  const snapshot = (): NavigatorAssistantSnapshot =>
    ({
      status: "ready",
      settingsTarget: { section: "navigator-assistant", setting: "default-model" },
      threadId: null,
      transcript: current,
      defaultProvider: {
        providerInstanceId: "00000000-0000-4000-8000-00000000b001",
        modelId: "model-a",
      },
      imageInput: "supported",
      visionReviewer: null,
    }) as NavigatorAssistantSnapshot;
  return {
    snapshot: async () => snapshot(),
    execute: async (command) => {
      if (command.kind === "send-message") {
        current = [
          ...current,
          { role: "user", text: command.prompt, createdAt: timestamp },
          { role: "assistant", text: `Answered: ${command.prompt}`, createdAt: timestamp },
        ];
      }
      return { kind: "message-sent", snapshot: snapshot() };
    },
  };
}

describe("App", () => {
  it("tells the user why a Code draft bound to a vanished Project cannot start, and creates nothing", async () => {
    const user = userEvent.setup();
    const codeApi = codesRecordingCreates();
    render(
      <App
        codeClient={codeApi}
        contextClient={contextClient()}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectsWithArchivedCodeProject()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(codeDraftShellBootstrap(otherProjectId))}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Fix the parser");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(
      await screen.findByText(
        "The folder this draft was started in is no longer available. Choose another folder before starting the thread.",
      ),
    ).toBeVisible();
    // The active "Octant" Project must never stand in for the archived one.
    for (const [command] of codeApi.execute.mock.calls) {
      expect(String((command as { readonly kind: string }).kind)).not.toMatch(/^create-/);
    }
  });

  /**
   * A ready provider that reports only chat-only models offers no usable Code
   * model. The Code create paths must say so instead of falling back to the
   * first picker entry — which the picker itself marks unusable — and failing
   * only after the work exists.
   */
  it("reports no usable Code model instead of starting a turn on a chat-only model", async () => {
    const user = userEvent.setup();
    const codeApi = codesRecordingCreates();
    render(
      <App
        codeClient={codeApi}
        contextClient={contextClient()}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithChatOnlyModel()}
        shellClient={client(codeDraftShellBootstrap(projectId))}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Refactor the parser");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(
      await screen.findByText(
        "No provider is available. Configure a provider before starting a Code thread.",
      ),
    ).toBeVisible();
    for (const [command] of codeApi.execute.mock.calls) {
      expect(String((command as { readonly kind: string }).kind)).not.toMatch(/^create-/);
    }
  });

  it("renders the authoritative Code overview and thread navigation", async () => {
    const codeApi = codes();
    render(
      <App
        chatClient={chats()}
        codeClient={codeApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", {
        name: /Controller foundation/,
      }),
    ).toBeVisible();
    expect(codeApi.thread).toHaveBeenCalledWith(codeThreadId);
    expect(codeApi.subscribe).toHaveBeenCalledWith(codeThreadId, 0, expect.any(AbortSignal));
  });

  it("hides the sidebar from its own control and brings it back from the window chrome", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Octant sidebar" })).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem("octant.shell.sidebar-collapsed.v1")).toBe("true");
    // The activated control is unmounted by its own state change, so focus
    // moves to the control that replaced it instead of the document body.
    expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.getByRole("complementary", { name: "Octant sidebar" })).toBeVisible();
    expect(globalThis.localStorage.getItem("octant.shell.sidebar-collapsed.v1")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveFocus();
  });

  it("sends Plugins to the Settings destination that actually exists", async () => {
    const user = userEvent.setup();
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Controller foundation" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set your name" }));
    await user.click(screen.getByRole("menuitem", { name: "Plugins" }));

    // Skills and extensions have a real Settings section, so the entry opens it
    // rather than a placeholder explaining where the surface would be.
    expect(await screen.findByRole("navigation", { name: "Settings sections" })).toBeVisible();
    expect(document.querySelector(".rail-placeholder")).toBeNull();
  });

  it("authenticates a browser session by exchanging a launch token from the URL fragment", async () => {
    const launchToken = `${"A".repeat(42)}A`;
    const browserCapability = `${"C".repeat(42)}A`;
    const originalHref = window.location.href;
    window.location.hash = `launchToken=${launchToken}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/shell/launch-session")) {
        return new Response(JSON.stringify({ windowId, capability: browserCapability }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const canvasResponse = canvasFetchPassthrough(url);
      if (canvasResponse !== undefined) {
        return canvasResponse;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const codeApi = codes();
      render(
        <App
          chatClient={chats()}
          codeClient={codeApi}
          projectClient={projects()}
          providerClient={providers()}
          shellClient={client(codeShellBootstrap())}
        />,
      );
      expect(
        await screen.findByRole("banner", {
          name: "Workspace actions for Controller foundation",
        }),
      ).toBeVisible();
      expect(fetchMock).toHaveBeenCalledWith(
        new URL("/api/shell/launch-session", window.location.origin),
        expect.objectContaining({ method: "POST" }),
      );
      expect(window.location.hash).toBe("");
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", originalHref);
    }
  });

  it("renders independent authoritative Chat sessions in every visible split pane", async () => {
    const chatApi = chats();

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(splitChatShellBootstrap())}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Older chat" })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Exact created chat" })).toBeVisible();
    await waitFor(() => {
      expect(chatApi.subscribe).toHaveBeenCalledWith(oldChatThreadId, 0, expect.any(AbortSignal));
      expect(chatApi.subscribe).toHaveBeenCalledWith(
        createdChatThreadId,
        0,
        expect.any(AbortSignal),
      );
    });
    const older = screen.getByRole("region", { name: "Workspace pane: Older chat" });
    const created = screen.getByRole("region", { name: "Workspace pane: Exact created chat" });
    expect(created).toHaveAttribute("data-active", "true");
    expect(created).toHaveAttribute("aria-current", "true");
    expect(older).toHaveAttribute("data-active", "false");
    expect(older).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("tablist", { name: /tabs/i })).toBeNull();
  });

  it("pins a sidebar thread into a new split pane and keeps the list pin separate", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const originalBootstrap = chatApi.bootstrap;
    chatApi.bootstrap = vi.fn(async () => {
      const value = await originalBootstrap();
      const first = value.threads[0];
      if (first === undefined) throw new Error("Expected a Chat thread.");
      return {
        ...value,
        threads: [
          ...value.threads,
          { ...first, id: createdChatThreadId, title: "Exact created chat" },
        ],
      };
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Older chat/ }));
    expect(await screen.findByRole("region", { name: "Workspace pane: Older chat" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Workspace pane: Exact created chat" })).toBeNull();

    await user.pointer({
      target: screen.getByRole("button", { name: /Exact created chat/ }),
      keys: "[MouseRight]",
    });
    await user.click(await screen.findByRole("menuitem", { name: "Pin in pane" }));

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Exact created chat" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Workspace pane: Older chat" })).toBeVisible();
    const pinned = screen.getByRole("region", { name: "Workspace pane: Exact created chat" });
    expect(pinned).toHaveAttribute("data-active", "true");
    expect(pinned).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("region", { name: "Workspace pane: Older chat" })).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
    expect(document.querySelector(".workspace-pane-actions")).toBeNull();
  });

  it("opens one App-level command palette that runs a host-derived navigation command", async () => {
    const user = userEvent.setup();
    const shellApi = client(chatShellBootstrap());

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );
    await screen.findByRole("region", { name: "Chat welcome" });

    await user.keyboard("{Control>}k{/Control}");

    const search = await screen.findByRole("combobox", { name: "Search commands" });
    // The dialog moves focus into the search field on a later frame.
    await waitFor(() => expect(search).toHaveFocus());
    // Exactly one palette exists for the window, mounted at the App level.
    expect(screen.getAllByRole("combobox", { name: "Search commands" })).toHaveLength(1);

    await user.keyboard("work");
    expect(screen.getByRole("option", { name: /Switch to Work/ })).toBeVisible();
    await user.keyboard("{Enter}");

    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "set-active-mode", mode: "work" }),
      }),
    );
    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
  });

  it("opens the exact thread returned by the authoritative New chat command", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const shellApi = client(chatShellBootstrap());

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "New chat");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(chatApi.execute).toHaveBeenCalledWith({
      kind: "create-chat-thread",
      title: "New chat",
    });
    expect(chatApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        threadId: createdChatThreadId,
        prompt: "New chat",
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Workspace pane: Exact created chat" }),
    ).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-surface",
          surface: expect.objectContaining({
            kind: "chat-thread",
            threadId: createdChatThreadId,
          }),
        }),
      }),
    );
    const sendCallOrder = vi
      .mocked(chatApi.execute)
      .mock.invocationCallOrder.find(
        (_, index) => vi.mocked(chatApi.execute).mock.calls[index]?.[0].kind === "send-chat-turn",
      );
    const openCallOrder = shellApi.execute.mock.invocationCallOrder.find(
      (_, index) =>
        shellApi.execute.mock.calls[index]?.[0].kind === "apply-workspace-operation" &&
        shellApi.execute.mock.calls[index]?.[0].operation.kind === "open-surface" &&
        shellApi.execute.mock.calls[index]?.[0].operation.surface.kind === "chat-thread",
    );
    expect(sendCallOrder).toBeDefined();
    expect(openCallOrder).toBeDefined();
    expect(sendCallOrder!).toBeLessThan(openCallOrder!);
  });

  it("creates a Project-scoped Chat thread through the authoritative quick start", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    } as never;
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async () => ({ projectId, active: [], history: [] }) as never);
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const projectWorkspace = applyWorkspaceOperation(initial.workspace, {
      kind: "open-surface",
      mode: "chat",
      paneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000890" as never,
        projectId,
        mode: "chat",
        title: "Launch planning",
      },
    });
    const shellApi = client({
      ...initial,
      workspace: {
        ...projectWorkspace,
        contextByMode: {
          ...projectWorkspace.contextByMode,
          chat: {
            ...projectWorkspace.contextByMode.chat,
            projectId: otherProjectId,
          },
        },
      },
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    await user.type(
      within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }),
      "Prepare launch brief",
    );
    await user.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    expect(chatApi.execute).toHaveBeenCalledWith({
      kind: "create-chat-thread",
      projectId,
      title: "Prepare launch brief",
    });
    expect(chatApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "send-chat-turn",
        threadId: createdChatThreadId,
        prompt: "Prepare launch brief",
      }),
    );
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "apply-workspace-operation",
          operation: expect.objectContaining({
            kind: "switch-project-surface",
            mode: "chat",
            surface: expect.objectContaining({
              kind: "chat-thread",
              threadId: createdChatThreadId,
            }),
          }),
        }),
      ),
    );
  });

  it("opens the created Project Chat thread when its first turn cannot be dispatched", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation()!;
    execute.mockImplementation(async (command) => {
      if (command.kind === "send-chat-turn") throw new Error("Provider is unavailable.");
      return await baseExecute(command);
    });
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z",
    } as never;
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async () => ({ projectId, active: [], history: [] }) as never);
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const shellApi = client({
      ...initial,
      workspace: applyWorkspaceOperation(initial.workspace, {
        kind: "open-surface",
        mode: "chat",
        paneId: layout.paneId,
        surface: {
          kind: "project",
          id: "00000000-0000-4000-8000-000000000891" as never,
          projectId,
          mode: "chat",
          title: "Launch planning",
        },
      }),
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    await user.type(
      within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }),
      "Prepare launch brief",
    );
    await user.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Exact created chat" }),
    ).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The first message could not be sent. Retry from the open thread.",
    );
  });

  it("applies the selected Chat provider and model before starting the first turn", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation()!;
    execute.mockImplementation(async (command) => {
      if (command.kind === "change-chat-provider") {
        return decodeChatCommandResult({
          kind: "thread-updated",
          thread: {
            id: createdChatThreadId,
            title: "Exact created chat",
            lifecycle: "active",
            providerInstanceId: command.providerInstanceId,
            modelId: command.modelId,
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be calm.",
            version: 2,
            createdAt: "2026-07-20T08:00:00.000Z",
            updatedAt: "2026-07-20T08:00:01.000Z",
          },
        });
      }
      return await baseExecute(command);
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.click(within(welcome).getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "GPT-5" }));
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "Use GPT-5");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-chat-provider",
      threadId: createdChatThreadId,
      expectedVersion: 1,
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
    });
    expect(execute).toHaveBeenCalledWith({
      kind: "send-chat-turn",
      threadId: createdChatThreadId,
      expectedVersion: 2,
      prompt: "Use GPT-5",
    });
    const commands = execute.mock.calls.map(([command]) => command.kind);
    expect(commands.indexOf("change-chat-provider")).toBeLessThan(
      commands.indexOf("send-chat-turn"),
    );
  });

  it("ignores a draft provider selection that became unselectable before create", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const instanceA = openAiProvider("90000000-0000-4000-8000-000000000001", "Primary Gateway");
    const instanceB = openAiProvider("90000000-0000-4000-8000-000000000002", "Backup Gateway");
    let primaryEnabled = true;
    const providerApi = {
      bootstrap: vi.fn(async () => ({
        instances: [{ ...instanceA, enabled: primaryEnabled }, instanceB],
        defaults: { permissionPersistence: "current-session" as const, version: 0 as never },
        observedStates: [
          observedProvider(instanceA.id, [
            providerModel({
              id: "gpt-5",
              displayName: "GPT-5",
              toolCalling: "supported",
              evidence: "supported",
            }),
          ]),
          observedProvider(instanceB.id, [
            providerModel({
              id: "backup-1",
              displayName: "Backup 1",
              toolCalling: "supported",
              evidence: "supported",
            }),
          ]),
        ],
      })),
      execute: vi.fn(
        async (command: ProviderRegistryCommand): Promise<ProviderRegistryCommandResult> => {
          if (command.kind === "set-provider-enabled") {
            primaryEnabled = command.enabled;
            return {
              kind: "provider-updated",
              instance: { ...instanceA, enabled: primaryEnabled },
            };
          }
          throw new Error(`Unexpected provider command ${command.kind}.`);
        },
      ),
      probe: vi.fn(),
    };
    const execute = vi.mocked(chatApi.execute);

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providerApi}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.click(within(welcome).getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Primary Gateway" }));
    await user.click(screen.getByRole("option", { name: "GPT-5" }));

    await openSettingsFromSidebar(user);
    fireEvent.click(await screen.findByRole("button", { name: "Providers & Models" }));
    await user.click(await screen.findByRole("switch", { name: "Enable Primary Gateway" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Enable Primary Gateway" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Back to app" }));

    const freshWelcome = await screen.findByRole("region", { name: "Chat welcome" });
    await user.type(within(freshWelcome).getByRole("textbox", { name: "First message" }), "Hi");
    await user.click(within(freshWelcome).getByRole("button", { name: "Start chat" }));

    await waitFor(() =>
      expect(execute.mock.calls.some(([command]) => command.kind === "send-chat-turn")).toBe(true),
    );
    expect(execute.mock.calls.some(([command]) => command.kind === "change-chat-provider")).toBe(
      false,
    );
  });

  it("opens a newly created chat while its first provider turn is still pending", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const shellApi = client(chatShellBootstrap());
    const execute = vi.mocked(chatApi.execute);
    const baseExecute = execute.getMockImplementation();
    let resolveSend: ((value: Awaited<ReturnType<ChatClient["execute"]>>) => void) | undefined;
    execute.mockImplementation((command) => {
      if (command.kind !== "send-chat-turn") return baseExecute!(command);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    });

    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    const welcome = await screen.findByRole("region", { name: "Chat welcome" });
    const createProject = screen.getByRole("button", { name: "New Chat Project" });
    expect(createProject).toHaveClass("project-section__add");
    expect(createProject).not.toHaveTextContent("New Chat Project");
    await user.type(within(welcome).getByRole("textbox", { name: "First message" }), "Open now");
    await user.click(within(welcome).getByRole("button", { name: "Start chat" }));

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Exact created chat" }),
    ).toBeVisible();
    expect(resolveSend).toBeDefined();
    resolveSend!(
      decodeChatCommandResult({
        kind: "thread-created",
        thread: {
          id: createdChatThreadId,
          title: "Exact created chat",
          lifecycle: "active",
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Be calm.",
          version: 1,
          createdAt: "2026-07-20T08:00:00.000Z",
          updatedAt: "2026-07-20T08:00:00.000Z",
        },
      }),
    );
  });

  it("enables overview Start thread and opens the created Work thread", async () => {
    const user = userEvent.setup();
    const shellApi = client(workShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => ({
        kind: "thread-created" as const,
        thread: decodeWorkThread({
          id: workThreadId,
          projectId: workProjectId,
          title: "Draft brief",
          lifecycle: "active",
          providerInstanceId: "90000000-0000-4000-8000-000000000001" as never,
          modelId: "gpt-5" as never,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
          workingDirectory: "." as never,
          version: 1,
          createdAt: "2026-07-26T09:30:00.000Z" as never,
          updatedAt: "2026-07-26T09:30:00.000Z" as never,
        }),
      })),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(async () => ({
        kind: "accepted",
        turn: {
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          threadId: workThreadId,
          turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          projectId: workProjectId,
          authority: {
            hostId: "local",
            projectId: workProjectId,
            bindingRevisionId: "30000000-0000-4000-8000-000000000001",
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: "90000000-0000-4000-8000-000000000001",
            modelId: "gpt-5",
          },
          status: "accepted",
          prompt: "Draft brief",
          transcript: [{ role: "user", text: "Draft brief" }],
          capabilities: {
            workspace: "project-backed",
            confinement: "project-root-confined",
            shell: "denied",
            git: "denied",
            worktree: "denied",
            pullRequest: "denied",
            code: "denied",
          },
          version: 1,
          acceptedAt: "2026-07-26T09:45:00.000Z",
          updatedAt: "2026-07-26T09:45:00.000Z",
        },
      })),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/work/overview")) {
          return new Response(
            JSON.stringify({
              projectId: workProjectId,
              filesAndArtifacts: [],
              workflowsAndThreads: [],
              approvals: [],
              versions: [],
              validation: [],
              exports: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const canvasResponse = canvasFetchPassthrough(url);
        if (canvasResponse !== undefined) {
          return canvasResponse;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "Start a new Work thread" });
    await user.type(prompt, "Draft brief");
    const start = screen.getByRole("button", { name: "Start thread" });
    expect(start).toBeEnabled();
    await user.click(start);

    expect(workThreadClient.execute).toHaveBeenCalledWith({
      kind: "create-work-thread",
      threadId: expect.any(String),
      projectId: workProjectId,
      title: "Draft brief",
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
      hostId: "local",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
    });
    expect(workTurnClient.startFirstTurn).toHaveBeenCalledWith({
      kind: "start-work-thread-turn",
      requestId: expect.any(String),
      threadId: workThreadId,
      turnId: expect.any(String),
      prompt: "Draft brief",
      authority: {
        hostId: "local",
        projectId: workProjectId,
        bindingRevisionId: "30000000-0000-4000-8000-000000000001",
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: "90000000-0000-4000-8000-000000000001",
        modelId: "gpt-5",
      },
    });
    expect(
      await screen.findByRole("region", { name: "Workspace pane: Draft brief" }),
    ).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-surface",
          mode: "work",
          surface: expect.objectContaining({
            kind: "work-thread",
            threadId: workThreadId,
          }),
        }),
      }),
    );
  });

  it("preserves the Work overview draft when authoritative create fails", async () => {
    const user = userEvent.setup();
    const shellApi = client(workShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => {
        throw new Error("Work Project is unavailable for this window.");
      }),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/work/overview")) {
          return new Response(
            JSON.stringify({
              projectId: workProjectId,
              filesAndArtifacts: [],
              workflowsAndThreads: [],
              approvals: [],
              versions: [],
              validation: [],
              exports: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const canvasResponse = canvasFetchPassthrough(url);
        if (canvasResponse !== undefined) {
          return canvasResponse;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "Start a new Work thread" });
    await user.type(prompt, "Keep this overview draft");
    await user.click(screen.getByRole("button", { name: "Start thread" }));

    expect(workThreadClient.execute).toHaveBeenCalled();
    expect(workTurnClient.startFirstTurn).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("Keep this overview draft");
    expect(
      screen.queryByRole("region", { name: "Workspace pane: Keep this overview draft" }),
    ).toBeNull();
  });

  it("creates a Work thread from a draft tab and opens the authoritative thread tab", async () => {
    const user = userEvent.setup();
    const shellApi = client(workDraftShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => ({
        kind: "thread-created" as const,
        thread: decodeWorkThread({
          id: workThreadId,
          projectId: workProjectId,
          title: "Release checklist",
          lifecycle: "active",
          providerInstanceId: "90000000-0000-4000-8000-000000000001" as never,
          modelId: "gpt-5" as never,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001" as never,
          workingDirectory: "." as never,
          version: 1,
          createdAt: "2026-07-26T09:45:00.000Z" as never,
          updatedAt: "2026-07-26T09:45:00.000Z" as never,
        }),
      })),
    };

    const workTurnClient = {
      startFirstTurn: vi.fn(async () => ({ kind: "accepted", turn: { status: "accepted" } })),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    await user.type(
      await screen.findByRole("textbox", { name: "First message" }),
      "Release checklist",
    );
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(workThreadClient.execute).toHaveBeenCalledWith({
      kind: "create-work-thread",
      threadId: expect.any(String),
      projectId: workProjectId,
      title: "Release checklist",
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
      hostId: "local",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
    });
    expect(workTurnClient.startFirstTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-work-thread-turn",
        threadId: workThreadId,
        prompt: "Release checklist",
        authority: expect.objectContaining({
          hostId: "local",
          projectId: workProjectId,
          bindingRevisionId: "30000000-0000-4000-8000-000000000001",
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: "90000000-0000-4000-8000-000000000001",
          modelId: "gpt-5",
        }),
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Workspace pane: Release checklist" }),
    ).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-surface",
          mode: "work",
          surface: expect.objectContaining({
            kind: "work-thread",
            threadId: workThreadId,
          }),
        }),
      }),
    );
  });

  it("preserves the Work draft tab when create fails before a first turn", async () => {
    const user = userEvent.setup();
    const shellApi = client(workDraftShellBootstrap());
    const workThreadClient = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(async () => {
        throw new Error("Selected provider is unavailable.");
      }),
    };
    const workTurnClient = {
      startFirstTurn: vi.fn(),
      lookupFirstTurn: vi.fn(),
      cancelFirstTurn: vi.fn(),
      transcript: vi.fn(async () => ({ threadId: workThreadId, turns: [] })),
    };

    render(
      <App
        contextClient={contextClient()}
        workThreadClient={workThreadClient as never}
        workTurnClient={workTurnClient as never}
        hostClient={hostClient() as never}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={workProjects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={shellApi}
      />,
    );

    const prompt = await screen.findByRole("textbox", { name: "First message" });
    await user.type(prompt, "Do not lose this Work draft");
    await user.click(screen.getByRole("button", { name: "Create thread" }));

    expect(workThreadClient.execute).toHaveBeenCalled();
    expect(workTurnClient.startFirstTurn).not.toHaveBeenCalled();
    expect(prompt).toHaveValue("Do not lose this Work draft");
    expect(
      await screen.findByText(
        /The thread could not be created\. Selected provider is unavailable\./,
      ),
    ).toBeVisible();
  });

  it("puts the active thread's context usage on the composer and keeps the dock free of Context", async () => {
    const user = userEvent.setup();
    const inspect = vi.fn<ContextClient["inspect"]>(async ({ subject }) => {
      const snapshot = contextFixture();
      const latestSent = snapshot.latestSent;
      const capacity = snapshot.capacity;
      const displayLabel =
        String(subject.aggregateId) === String(createdChatThreadId)
          ? "Exact created chat"
          : "Older chat";
      return {
        ...snapshot,
        subject,
        displayLabel,
        next: {
          ...snapshot.next,
          manifest: { ...snapshot.next.manifest, subject },
        },
        ...(latestSent === undefined
          ? {}
          : { latestSent: { ...latestSent, manifest: { ...latestSent.manifest, subject } } }),
        ...(capacity === undefined ? {} : { capacity: { ...capacity, subject } }),
      };
    });
    const contextApi: ContextClient = {
      inspect,
      execute: vi.fn(),
    };

    render(
      <App
        chatClient={chats()}
        contextClient={contextApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(splitChatShellBootstrap())}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Exact created chat" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(contextApi.inspect).toHaveBeenCalledWith(
        {
          subject: { aggregateType: "chat-thread", aggregateId: String(createdChatThreadId) },
        },
        expect.any(AbortSignal),
      ),
    );
    const inspectCalls = inspect.mock.calls.length;
    const created = screen.getByRole("region", { name: "Workspace pane: Exact created chat" });
    const meter = await within(created).findByRole("button", {
      name: /Show context usage for Exact created chat/i,
    });
    expect(meter).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Workspace pane: Older chat" })).queryByRole(
        "button",
        { name: /context usage/i },
      ),
    ).toBeNull();

    await user.click(meter);
    const popover = screen.getByRole("dialog", { name: "Context usage" });
    expect(popover).toHaveTextContent("Used104 · Provider reported");
    expect(popover).toHaveTextContent("Maximum1,000");
    expect(popover).toHaveTextContent("Percentage10%");
    expect(popover).toHaveTextContent("Free space796");
    expect(popover).toHaveTextContent(/Tools2 loaded· 6 deferred/);
    expect(inspect.mock.calls.length).toBe(inspectCalls);

    await user.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(await screen.findByRole("dialog", { name: "Context inspector" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Rebuild context plan" })).toBeVisible();
    expect(inspect.mock.calls.length).toBe(inspectCalls);
    await user.click(screen.getByRole("button", { name: "Pin Repository search next turn" }));
    expect(contextApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "update-context-overrides" }),
      expect.any(AbortSignal),
    );

    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}{Shift>}u{/Shift}{/Control}");
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();
    expect(inspect.mock.calls.length).toBe(inspectCalls);

    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).queryByRole("tab", { name: "Context" })).toBeNull();
    expect(within(dock).queryByRole("button", { name: /^Context$/ })).toBeNull();
    expect(within(dock).queryByRole("heading", { name: "Context inspector" })).toBeNull();
  });

  it("closes the previous pane's context popover and retargets usage when the active pane changes", async () => {
    const user = userEvent.setup();
    const contextApi: ContextClient = {
      inspect: vi.fn(async ({ subject }) => {
        const snapshot = contextFixture();
        const latestSent = snapshot.latestSent;
        const capacity = snapshot.capacity;
        const displayLabel =
          String(subject.aggregateId) === String(createdChatThreadId)
            ? "Exact created chat"
            : "Older chat";
        return {
          ...snapshot,
          subject,
          displayLabel,
          next: {
            ...snapshot.next,
            manifest: { ...snapshot.next.manifest, subject },
          },
          ...(latestSent === undefined
            ? {}
            : { latestSent: { ...latestSent, manifest: { ...latestSent.manifest, subject } } }),
          ...(capacity === undefined ? {} : { capacity: { ...capacity, subject } }),
        };
      }),
      execute: vi.fn(),
    };

    render(
      <App
        chatClient={chats()}
        contextClient={contextApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(splitChatShellBootstrap())}
      />,
    );

    const created = await screen.findByRole("region", {
      name: "Workspace pane: Exact created chat",
    });
    await user.click(
      await within(created).findByRole("button", {
        name: /Show context usage for Exact created chat/i,
      }),
    );
    expect(screen.getByRole("dialog", { name: "Context usage" })).toBeVisible();

    await user.click(screen.getByRole("region", { name: "Workspace pane: Older chat" }));
    expect(screen.queryByRole("dialog", { name: "Context usage" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(contextApi.inspect).toHaveBeenCalledWith(
        {
          subject: { aggregateType: "chat-thread", aggregateId: String(oldChatThreadId) },
        },
        expect.any(AbortSignal),
      ),
    );
    const older = screen.getByRole("region", { name: "Workspace pane: Older chat" });
    expect(
      await within(older).findByRole("button", { name: /Show context usage for Older chat/i }),
    ).toBeVisible();
    expect(within(created).queryByRole("button", { name: /context usage/i })).toBeNull();
  });

  it("previews and authoritatively commits a wide left-sidebar resize", async () => {
    const shellApi = client();
    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );
    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    const separator = screen.getByRole("separator", { name: "Resize navigation sidebar" });
    Object.assign(separator, {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 232, pointerId: 30 });
    fireEvent.pointerMove(separator, { clientX: 300, pointerId: 30 });
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "300px" }),
    );
    expect(shellApi.execute).not.toHaveBeenCalled();

    fireEvent.pointerUp(separator, { clientX: 300, pointerId: 30 });
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "replace-settings",
          settings: expect.objectContaining({ sidebarWidth: 300 }),
        }),
      ),
    );
    expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "300px" });
  });

  it("keeps the committed desktop width and omits horizontal resizing when responsive", async () => {
    render(
      <App
        isNarrow
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...codeShellBootstrap(),
          settings: { ...settingsPastFirstRun(), sidebarWidth: 320 },
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    expect(screen.queryByRole("separator", { name: "Resize navigation sidebar" })).toBeNull();
    expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "320px" });
  });

  it("shows Project memory on Overview and refuses a restored Project memory dock tab", async () => {
    const user = userEvent.setup();
    const value = projectBootstrap();
    const secondProject = { ...value.active[0]!, id: otherProjectId, name: "Other Repository" };
    const projectApi = projects({
      ...value,
      active: [...value.active, secondProject],
      availability: [
        { ...value.availability[0]!, status: "available" as const },
        { ...value.availability[0]!, projectId: otherProjectId, status: "available" as const },
      ],
    });
    const shellApi = client({
      ...codeShellBootstrap(),
      settings: { ...settingsPastFirstRun(), lastContextSurface: "project-memory" },
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    vi.mocked(projectApi.memory).mockResolvedValue({
      projectId,
      active: [
        {
          id: "00000000-0000-4000-8000-000000000882",
          projectId,
          kind: "fact",
          content: "Keep this Project's memory visible.",
          provenance: { kind: "user-authored" },
          author: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000881" },
          status: "active",
          version: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
          updatedAt: "2026-08-11T09:00:00.000Z",
        },
      ],
      history: [],
    } as never);

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );

    await openSidebarProject(user, "Octant");
    const overview = (await screen.findByDisplayValue("Octant")).closest(".project-overview");
    if (!(overview instanceof HTMLElement)) throw new Error("Expected Octant Overview.");
    expect(await within(overview).findByText("Keep this Project's memory visible.")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(document.querySelector("#environment-hub, #context-sidebar")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Project memory" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Navigator" })).not.toBeInTheDocument();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);

    vi.mocked(projectApi.memory).mockImplementation(async (requestedProjectId) => ({
      projectId: requestedProjectId,
      active: [],
      history: [],
    }));
    await openSidebarProject(user, "Other Repository");
    const otherOverview = screen.getByDisplayValue("Other Repository").closest(".project-overview");
    if (!(otherOverview instanceof HTMLElement)) throw new Error("Expected other Overview.");
    await waitFor(() => expect(projectApi.memory).toHaveBeenCalledWith(otherProjectId));
    expect(within(otherOverview).queryByText("Keep this Project's memory visible.")).toBeNull();
  });

  it("opens Navigator from the profile control without changing the active Project or thread", async () => {
    const user = userEvent.setup();
    render(
      <App
        codeClient={codes()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        navigatorAssistantClient={navigatorAssistantClient([
          {
            role: "user",
            text: "Earlier question",
            createdAt: "2026-08-15T09:00:00.000Z" as never,
          },
        ])}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...codeShellBootstrap(),
          settings: { ...settingsPastFirstRun(), lastContextSurface: "navigator" },
        })}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Navigator" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Set your name" }));
    await user.click(screen.getByRole("menuitem", { name: "Navigator" }));

    const navigator = await screen.findByRole("dialog", { name: "Navigator" });
    expect(navigator).toBeVisible();
    expect(await within(navigator).findByText("Earlier question")).toBeVisible();
    expect(within(navigator).getByText("Running on model-a")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Navigator" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();

    await user.type(within(navigator).getByLabelText("Message Navigator"), "Stay on this thread");
    await user.click(within(navigator).getByRole("button", { name: "Send to Navigator" }));
    expect(await within(navigator).findByText("Answered: Stay on this thread")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigator" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "Set your name" }));
    await user.click(screen.getByRole("menuitem", { name: "Navigator" }));
    expect(await screen.findByRole("dialog", { name: "Navigator" })).toBeVisible();
    expect(screen.getByText("Answered: Stay on this thread")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
  });

  it("opens memory for the invoking Chat Project instead of the globally active split", async () => {
    const user = userEvent.setup();
    const betaMemory = deferred<Awaited<ReturnType<ProjectClient["memory"]>>>();
    const firstChatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const secondChatProject = {
      ...firstChatProject,
      id: otherProjectId,
      name: "Project Beta",
      rank: "1/1" as ProjectBootstrap["active"][number]["rank"],
    };
    const projectApi = projects({
      active: [firstChatProject, secondChatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn((requestedProjectId) => {
      if (String(requestedProjectId) === String(otherProjectId)) return betaMemory.promise;
      return Promise.resolve({
        projectId: requestedProjectId,
        active: Array.from({ length: 9 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          projectId: requestedProjectId,
          kind: "fact",
          content: `Memory ${index + 1}`,
          provenance: { kind: "user-authored" },
          author: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000801" },
          status: "active",
          version: 1,
          createdAt: "2026-08-11T09:00:00.000Z",
          updatedAt: "2026-08-11T09:00:00.000Z",
        })),
        history: [],
      } as never);
    });
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const withFirstProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-surface",
      mode: "chat",
      paneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000883" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });
    // A pane holds one surface, so the second Project opens through a split
    // rather than a second tab in the same group.
    const splitProjects = applyWorkspaceOperation(withFirstProject, {
      kind: "split-pane",
      mode: "chat",
      targetPaneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000884" as never,
        projectId: otherProjectId,
        mode: "chat",
        title: "Project Beta",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000885" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000886" as never,
      newPaneId: "00000000-0000-4000-8000-000000000887" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: splitProjects,
          workspaceVersion: splitProjects.version,
        })}
      />,
    );

    const alphaOverview = await screen.findByDisplayValue("Project Alpha");
    const alphaProject = alphaOverview.closest(".project-overview");
    if (!(alphaProject instanceof HTMLElement)) throw new Error("Expected Project Alpha overview.");
    const alphaMemory = await within(alphaProject).findByRole("region", { name: "Project memory" });
    expect(await within(alphaMemory).findByText("Memory 1")).toBeVisible();

    const betaOverview = screen.getByDisplayValue("Project Beta").closest(".project-overview");
    if (!(betaOverview instanceof HTMLElement)) throw new Error("Expected Project Beta overview.");
    const betaMemoryRegion = within(betaOverview).getByRole("region", { name: "Project memory" });
    expect(within(betaMemoryRegion).queryByText("Memory 1")).not.toBeInTheDocument();
    expect(within(betaMemoryRegion).getByRole("button", { name: "Add memory" })).toBeDisabled();

    betaMemory.resolve({ projectId: otherProjectId, active: [], history: [] } as never);
    await waitFor(() =>
      expect(within(betaMemoryRegion).getByRole("button", { name: "Add memory" })).toBeEnabled(),
    );
    expect(within(betaMemoryRegion).queryByText("Memory 1")).not.toBeInTheDocument();
  });

  it("keeps each Overview's memory with its Project when another pane is activated", async () => {
    const user = userEvent.setup();
    const firstChatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const secondChatProject = {
      ...firstChatProject,
      id: otherProjectId,
      name: "Project Beta",
      rank: "1/1" as ProjectBootstrap["active"][number]["rank"],
    };
    const projectApi = projects({
      active: [firstChatProject, secondChatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(
      async (requestedProjectId) =>
        ({ projectId: requestedProjectId, active: [], history: [] }) as never,
    );
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const withFirstProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-surface",
      mode: "chat",
      paneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000883" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });
    const splitProjects = applyWorkspaceOperation(withFirstProject, {
      kind: "split-pane",
      mode: "chat",
      targetPaneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000884" as never,
        projectId: otherProjectId,
        mode: "chat",
        title: "Project Beta",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000885" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000886" as never,
      newPaneId: "00000000-0000-4000-8000-000000000887" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: splitProjects,
          workspaceVersion: splitProjects.version,
        })}
      />,
    );

    const alphaOverview = await screen.findByDisplayValue("Project Alpha");
    const alphaProject = alphaOverview.closest(".project-overview");
    if (!(alphaProject instanceof HTMLElement)) throw new Error("Expected Project Alpha overview.");
    expect(await within(alphaProject).findByRole("heading", { name: "Memory" })).toBeVisible();

    await user.click(screen.getByDisplayValue("Project Beta"));
    const betaOverview = screen.getByDisplayValue("Project Beta").closest(".project-overview");
    if (!(betaOverview instanceof HTMLElement)) throw new Error("Expected Project Beta overview.");
    expect(within(betaOverview).queryByText("Project Alpha")).not.toBeInTheDocument();
    expect(within(betaOverview).getByRole("heading", { name: "Memory" })).toBeVisible();
    await waitFor(() => expect(projectApi.memory).toHaveBeenCalledWith(otherProjectId));
  });

  it("does not attribute Overview memory to a pane that holds no Project", async () => {
    const user = userEvent.setup();
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(
      async () =>
        ({
          projectId,
          active: [
            {
              id: "00000000-0000-4000-8000-000000000892",
              projectId,
              kind: "fact",
              content: "Alpha remembers the roadmap.",
              provenance: { kind: "user-authored" },
              author: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000891" },
              status: "active",
              version: 1,
              createdAt: "2026-08-11T09:00:00.000Z",
              updatedAt: "2026-08-11T09:00:00.000Z",
            },
          ],
          history: [],
        }) as never,
    );
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const withProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-surface",
      mode: "chat",
      paneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000893" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });
    const withThreadPane = applyWorkspaceOperation(withProject, {
      kind: "split-pane",
      mode: "chat",
      targetPaneId: layout.paneId,
      surface: {
        kind: "chat-thread",
        id: "00000000-0000-4000-8000-000000000894" as never,
        threadId: oldChatThreadId as never,
        mode: "chat",
        title: "Older chat",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000895" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000896" as never,
      newPaneId: "00000000-0000-4000-8000-000000000897" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });

    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: withThreadPane,
          workspaceVersion: withThreadPane.version,
        })}
      />,
    );

    const alphaOverview = await screen.findByDisplayValue("Project Alpha");
    const alphaProject = alphaOverview.closest(".project-overview");
    if (!(alphaProject instanceof HTMLElement)) throw new Error("Expected Project Alpha overview.");
    const alphaMemory = await within(alphaProject).findByRole("region", { name: "Project memory" });
    await within(alphaMemory).findByText("Alpha remembers the roadmap.");

    await user.click(screen.getByRole("region", { name: "Workspace pane: Older chat" }));

    expect(screen.queryByRole("tab", { name: "Project memory" })).not.toBeInTheDocument();
    expect(alphaMemory).toHaveTextContent("Alpha remembers the roadmap.");
    expect(
      screen.getByRole("region", { name: "Workspace pane: Older chat" }),
    ).not.toHaveTextContent("Alpha remembers the roadmap.");
  });

  it("shows a Chat Project one threads list in its Overview and opens a thread from it", async () => {
    const user = userEvent.setup();
    const chatProject = {
      id: projectId,
      type: "chat",
      name: "Project Alpha",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
    } as ProjectBootstrap["active"][number];
    const projectApi = projects({
      active: [chatProject],
      archived: [],
      availability: [],
      memory: [],
    });
    projectApi.memory = vi.fn(async (requestedProjectId) => ({
      projectId: requestedProjectId,
      active: [],
      history: [],
    }));
    const initial = chatShellBootstrap();
    const layout = initial.workspace.layouts.chat;
    if (layout.kind !== "pane") throw new Error("Expected the default Chat pane.");
    const withProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-surface",
      mode: "chat",
      paneId: layout.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000888" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });

    render(
      <App
        chatClient={chats({ threadProjectId: String(projectId) })}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client({
          ...initial,
          workspace: withProject,
          workspaceVersion: withProject.version,
        })}
      />,
    );

    // Chat Projects already carry their own threads list, which can create a
    // thread and expand the full list, so the shared section stands down and
    // the overview shows exactly one list rather than the same threads twice.
    // The Active threads region is in the document while Chat bootstrap is
    // still loading, so wait for the thread row rather than treating the
    // heading as a filled list.
    const threads = await screen.findByRole("region", { name: "Active threads" });
    expect(
      screen.queryByRole("region", { name: /Threads and recent activity/ }),
    ).not.toBeInTheDocument();
    // The region exists while the list still says Loading, so wait for the
    // thread row rather than clicking a button that has not been rendered yet.
    await user.click(await within(threads).findByRole("button", { name: /Older chat/ }));

    expect(await screen.findByRole("region", { name: "Workspace pane: Older chat" })).toBeVisible();
  });

  it("keeps the owning Code Project active while a Code thread tab is selected", async () => {
    const user = userEvent.setup();
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const shell = codeShellBootstrap();

    render(
      <App
        codeClient={codes()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...shell,
          settings: { ...shell.settings, lastContextSurface: "project-memory" },
        })}
      />,
    );

    expect(
      await screen.findByRole(
        "region",
        { name: "Workspace pane: Controller foundation" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).queryByRole("tab", { name: "Project memory" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("tab", { name: "Navigator" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("tab", { name: "Thread tools" })).not.toBeInTheDocument();
    expect(within(dock).getByRole("button", { name: "Files" })).toBeVisible();
    expect(within(dock).queryByRole("button", { name: "Project memory" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Navigator" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Context" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Thread tools" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Plan" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Delivery" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: "Agents" })).not.toBeInTheDocument();
  });

  it("offers Plan only when the thread has a current plan artifact", async () => {
    const user = userEvent.setup();
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const planClient = {
      read: vi.fn(async () => ({
        plan: {
          id: "20000000-0000-4000-8000-000000000001",
          threadId: String(codeThreadId),
          revisionId: "30000000-0000-4000-8000-000000000001",
          title: "Land the replay fix",
          status: "proposed",
          steps: [
            {
              stepId: "40000000-0000-4000-8000-000000000001",
              position: 0,
              title: "Reproduce the gap",
              status: "pending",
            },
          ],
          proposedAt: "2026-08-18T09:00:00.000Z",
          updatedAt: "2026-08-18T09:00:00.000Z",
          version: 1,
        },
        history: [],
      })),
      execute: vi.fn(),
    };

    render(
      <App
        codeClient={codes()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        planClient={planClient as never}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByRole("button", { name: "Plan" })).toBeVisible();
    await user.click(within(dock).getByRole("button", { name: "Plan" }));
    expect(await within(dock).findByText("Land the replay fix")).toBeVisible();
    expect(within(dock).queryByRole("button", { name: "Propose plan" })).not.toBeInTheDocument();
  });

  it("offers Delivery only when a target is enabled", async () => {
    const user = userEvent.setup();
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const shipClient = {
      targets: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000702",
          extensionId: "ship-to-a-branch",
          displayName: "Public site",
          destination: {
            kind: "git-branch",
            remoteName: "origin",
            branch: "published",
            artifactDirectory: "dist",
          },
          enabled: true,
          credentialReference: "credential/site",
          version: 2,
          updatedAt: "2026-08-19T09:00:00.000Z",
        },
      ]),
      execute: vi.fn(),
    };

    render(
      <App
        codeClient={codes()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(codeShellBootstrap())}
        shipClient={shipClient as never}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByRole("button", { name: "Delivery" })).toBeVisible();
    expect(within(dock).queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("keeps the right sidebar closed after restart until the user opens it", async () => {
    const user = userEvent.setup();
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "pane") throw new Error("Default Code layout must be a pane.");
    const restoredWorkspace = applyWorkspaceOperation(initial, {
      kind: "open-surface",
      mode: "code",
      paneId: code.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000630" as never,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const value = projectBootstrap();
    const projectApi = projects({
      ...value,
      availability: [{ ...value.availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const shellApi = client({
      ...bootstrap(),
      settings: { ...settingsPastFirstRun(), lastContextSurface: "project-memory" },
      workspace: restoredWorkspace,
      workspaceVersion: restoredWorkspace.version,
    });

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={shellApi}
      />,
    );

    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).getByText("Open a tool beside the active pane.")).toBeVisible();
    expect(within(dock).queryByRole("tab", { name: "Project memory" })).not.toBeInTheDocument();
    expect(within(dock).queryByRole("tab", { name: "Navigator" })).not.toBeInTheDocument();
  });

  it("keeps Project context and the Right Utility Dock on the active split group", async () => {
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "pane") throw new Error("Default Code layout must be a pane.");
    const projectTabId = "00000000-0000-4000-8000-000000000631" as never;
    const withProject = applyWorkspaceOperation(initial, {
      kind: "open-surface",
      mode: "code",
      paneId: code.paneId,
      surface: {
        kind: "project",
        id: projectTabId,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const withSplit = applyWorkspaceOperation(withProject, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: code.paneId,
      surface: {
        kind: "welcome",
        id: "00000000-0000-4000-8000-000000000632" as never,
        mode: "code",
        title: "Welcome to Code",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000633" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000634" as never,
      newPaneId: "00000000-0000-4000-8000-000000000635" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });
    // Re-activate the Project pane: the dock should follow the active pane.
    const withSplitProject = applyWorkspaceOperation(withSplit, {
      kind: "open-surface",
      mode: "code",
      paneId: code.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000636" as never,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const projectApi = projects();
    vi.mocked(projectApi.memory).mockResolvedValue({ projectId, active: [], history: [] });

    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client({
          ...codeShellBootstrap(),
          workspace: withSplitProject,
          workspaceVersion: withSplitProject.version,
        })}
      />,
    );

    expect(await screen.findByRole("button", { name: "Open Right sidebar" })).toBeVisible();
    expect(screen.getByRole("banner", { name: "Workspace actions for Octant" })).toBeVisible();
  });

  it("uses one narrow modal dock and restores focus through Escape dismissal", async () => {
    const user = userEvent.setup();
    const projectApi = projects();
    vi.mocked(projectApi.memory).mockResolvedValue({ projectId, active: [], history: [] });
    render(
      <App
        isNarrow
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    const overview = (await screen.findByDisplayValue("Octant")).closest(".project-overview");
    if (!(overview instanceof HTMLElement)) throw new Error("Expected Octant Overview.");
    expect(await within(overview).findByRole("heading", { name: "Memory" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Project memory" })).toBeNull();

    const overflow = screen.getByRole("button", { name: "More window actions" });
    await user.click(overflow);
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));

    expect(await screen.findByRole("dialog", { name: "Right sidebar" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(document.querySelectorAll(".octant-dialog__backdrop")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__viewport")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__popup")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(overflow).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Right sidebar" })).toBeNull();
  });

  it("does not disclose a thread environment for a Project overview", async () => {
    const user = userEvent.setup();
    render(
      <App
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    await openSidebarProject(user, "Octant");
    expect(screen.getByRole("button", { name: "Open Right sidebar" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Code environment" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    expect(await screen.findByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code environment" })).toBeNull();
  });

  it("treats the native minimum width as compact desktop chrome", async () => {
    const originalMatchMedia = window.matchMedia;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn(() => ({
      matches: true,
      media: "(max-width: 960px)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      render(
        <App
          launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
          projectClient={projects()}
          projectWindowCapability={projectWindowCapability}
          shellClient={client()}
        />,
      );

      expect(await screen.findByRole("button", { name: "More window actions" })).toBeVisible();
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 960px)");
      expect(document.querySelector(".shell")).toHaveStyle({
        "--octant-sidebar-width": "232px",
      });
      expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("integrates host-resolved material and honest top chrome actions", async () => {
    const user = userEvent.setup();
    let resolveMaterial: ((material: "translucent" | "opaque") => void) | undefined;
    const setSidebarMaterialPreference = vi.fn();
    const subscribeResolvedMaterial = vi.fn(
      (listener: (material: "translucent" | "opaque") => void) => {
        resolveMaterial = listener;
        return () => undefined;
      },
    );
    let reportVibrancy: ((vibrancy: "sidebar" | null) => void) | undefined;
    const subscribeResolvedSidebarVibrancy = vi.fn(
      (listener: (vibrancy: "sidebar" | null) => void) => {
        reportVibrancy = listener;
        return () => undefined;
      },
    );
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability: "C".repeat(43),
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference,
      subscribeResolvedMaterial,
      subscribeResolvedSidebarVibrancy,
    };
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        shellClient={client(bootstrap())}
      />,
    );

    expect(await screen.findByRole("banner")).toHaveClass("window-chrome--material-opaque");
    expect(document.querySelector(".shell")).toHaveClass("shell--material-opaque");
    expect(screen.getByRole("button", { name: "Open Right sidebar" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Zen" })).not.toBeInTheDocument();
    expect(document.querySelector(".window-chrome__identity")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workspace pane: Welcome to Chat" })).toBeVisible();
    expect(screen.getByRole("banner")).toHaveAccessibleName(
      "Workspace actions for Welcome to Chat",
    );

    await waitFor(() => expect(subscribeResolvedMaterial).toHaveBeenCalledOnce());
    expect(setSidebarMaterialPreference).toHaveBeenLastCalledWith("system");
    expect(subscribeResolvedMaterial.mock.invocationCallOrder[0]).toBeLessThan(
      setSidebarMaterialPreference.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER,
    );
    resolveMaterial?.("translucent");
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveClass("shell--material-translucent"),
    );

    // The near-opaque native wash relaxes only on the host's report that
    // window vibrancy is applied, and returns as soon as the host withdraws it.
    expect(document.documentElement.dataset.octantHostVibrancy).toBeUndefined();
    reportVibrancy?.("sidebar");
    await waitFor(() => expect(document.documentElement.dataset.octantHostVibrancy).toBe("active"));
    reportVibrancy?.(null);
    await waitFor(() =>
      expect(document.documentElement.dataset.octantHostVibrancy).toBeUndefined(),
    );

    await openSettingsFromSidebar(user);
    expect(document.querySelector(".shell")).toHaveClass(
      "shell-frame--standalone",
      "shell--material-translucent",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Appearance" }));
    await user.click(screen.getByRole("switch", { name: "Translucent sidebar" }));
    await waitFor(() => expect(setSidebarMaterialPreference).toHaveBeenLastCalledWith("opaque"));
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(document.querySelector(".shell")).toHaveClass("shell--material-opaque");

    await openSettingsFromSidebar(user);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    await user.click(screen.getByRole("button", { name: "Reset native window bounds" }));
    expect(hostBridge.resetBounds).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        "Native window bounds reset.",
      ),
    );
  });

  it("uses the CSS translucent sidebar fallback when no native host is available", async () => {
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await screen.findByRole("button", { name: "Set your name" });
    await waitFor(() =>
      expect(document.querySelector(".shell")).toHaveClass("shell--material-translucent"),
    );
  });

  it("applies reduced transparency to the native sidebar material", async () => {
    const setSidebarVibrancyMode = vi.fn();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      getHostCapabilities: () => ({ sidebarVibrancySupported: true }),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      setSidebarVibrancyMode,
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    const themeClient = {
      bootstrap: vi.fn(async () => ({
        settings: {
          ...DEFAULT_THEME_SETTINGS,
          reducedTransparency: true,
          sidebarBackground: {
            kind: "preset" as const,
            presetId: "gradient-aurora" as never,
            overlayColor: "#0d0d0f" as never,
            overlayOpacity: 40 as never,
            vibrancyMode: "subtle" as const,
          },
        },
        version: 1 as never,
      })),
      execute: vi.fn(),
    };

    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
        themeClient={themeClient as never}
      />,
    );

    await waitFor(() => expect(themeClient.bootstrap).toHaveBeenCalledOnce());
    await waitFor(() => expect(setSidebarVibrancyMode).toHaveBeenLastCalledWith("off"));
    expect(document.querySelector("[data-octant-sidebar-background]")).not.toBeInTheDocument();
  });

  it("applies increased contrast to the rendered sidebar overlay", async () => {
    const themeClient = {
      bootstrap: vi.fn(async () => ({
        settings: {
          ...DEFAULT_THEME_SETTINGS,
          increasedContrast: true,
          sidebarBackground: {
            kind: "preset" as const,
            presetId: "gradient-aurora" as never,
            overlayColor: "#0d0d0f" as never,
            overlayOpacity: 20 as never,
            vibrancyMode: "subtle" as const,
          },
        },
        version: 1 as never,
      })),
      execute: vi.fn(),
    };

    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
        themeClient={themeClient as never}
      />,
    );

    await waitFor(() =>
      expect(document.querySelector("[data-octant-sidebar-overlay]")).toHaveStyle({
        opacity: "0.8",
      }),
    );
  });

  it("routes menu-bar Start new agent through the ordinary workspace composer", async () => {
    let startNewAgent: (() => void) | undefined;
    const subscribeStartNewAgent = vi.fn((listener: () => void) => {
      startNewAgent = listener;
      return () => undefined;
    });
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
      subscribeStartNewAgent,
    };
    const shellApi = client(chatShellBootstrap());
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        shellClient={shellApi}
      />,
    );

    await screen.findByRole("region", { name: "Workspace pane: Welcome to Chat" });
    await waitFor(() => expect(subscribeStartNewAgent).toHaveBeenCalled());
    await act(async () => startNewAgent?.());
    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-surface" &&
            command.operation.mode === "chat" &&
            command.operation.surface.kind === "draft-thread",
        ),
      ).toBe(true),
    );
  });

  it("consumes an Electron Project-window target once after Project bootstrap", async () => {
    const shellApi = client(bootstrap());
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: { kind: "project", projectId: String(projectId) },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        shellClient={shellApi}
      />,
    );

    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-surface" &&
            command.operation.surface.kind === "project" &&
            String(command.operation.surface.projectId) === String(projectId),
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      shellApi.execute.mock.calls.filter(
        ([command]) =>
          command.kind === "apply-workspace-operation" &&
          command.operation.kind === "open-surface" &&
          command.operation.surface.kind === "project",
      ),
    ).toHaveLength(1);
  });

  it("opens the exact Code thread carried by an Electron Project-window target", async () => {
    const shellApi = client(bootstrap());
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: {
        kind: "project-thread",
        projectId: String(projectId),
        mode: "code",
        threadId: String(codeThreadId),
      },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        codeClient={codes()}
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        shellClient={shellApi}
      />,
    );

    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-surface" &&
            command.operation.surface.kind === "code-overview" &&
            String(command.operation.surface.threadId) === String(codeThreadId),
        ),
      ).toBe(true),
    );
  });

  it("does not consume a Project-window target whose canonical thread belongs elsewhere", async () => {
    const shellApi = client(bootstrap());
    const available = projectBootstrap();
    const projectApi = projects({
      ...available,
      active: [
        ...available.active,
        { ...available.active[0]!, id: otherProjectId, name: "Other repository" },
      ],
    });
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      initialProjectTarget: {
        kind: "project-thread",
        projectId: String(otherProjectId),
        mode: "code",
        threadId: String(codeThreadId),
      },
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      openInNewWindow: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };

    render(
      <App
        codeClient={codes()}
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={shellApi}
      />,
    );

    await waitFor(() => expect(projectApi.bootstrap).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      shellApi.execute.mock.calls.some(
        ([command]) =>
          command.kind === "apply-workspace-operation" &&
          command.operation.kind === "open-surface" &&
          command.operation.surface.kind === "code-overview" &&
          String(command.operation.surface.threadId) === String(codeThreadId),
      ),
    ).toBe(false);
  });

  it("bootstraps the durable shell and exposes the honest Project hierarchy", async () => {
    const user = userEvent.setup();
    const codeApi = codes();
    const readyCodeBootstrap = await codeApi.bootstrap();
    const readyCodeThread = await codeApi.thread(codeThreadId);
    const codeBootstrap = deferred<Awaited<ReturnType<CodeClient["bootstrap"]>>>();
    const codeThread = deferred<Awaited<ReturnType<CodeClient["thread"]>>>();
    codeApi.bootstrap = vi.fn(() => codeBootstrap.promise);
    codeApi.thread = vi.fn(() => codeThread.promise);
    const projectApi = projects();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    render(
      <App
        codeClient={codeApi}
        hostBridge={hostBridge}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={client()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Loading Octant workspace");
    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    expect(document.querySelector(".shell")).toHaveStyle({
      "--octant-sidebar-width": "232px",
    });
    expect(document.querySelector(".shell")?.getAttribute("style")).not.toMatch(
      /grid-template-columns/i,
    );
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveClass("sidebar");
    expect(document.querySelectorAll(".shell-frame")).toHaveLength(1);
    expect(document.querySelector(".shell-frame")?.children[0]).toBe(screen.getByRole("banner"));
    expect(document.querySelector(".shell-frame")?.children[1]).toBe(sidebar);
    expect(document.querySelector(".shell-frame")?.children[2]).toHaveClass(
      "shell-frame__sidebar-resize",
    );
    expect(document.querySelector(".shell-frame")?.children[3]).toHaveClass("workspace-layer");
    expect(sidebar).not.toHaveClass("window-drag-region");
    expect(sidebar.querySelector(".sidebar__drag-surface")).toHaveClass("window-drag-region");
    expect(sidebar.querySelector(".sidebar__content")).toHaveClass("window-no-drag");
    expect(within(sidebar).getByRole("button", { name: "Workspace mode, Code" })).toHaveClass(
      "window-no-drag",
    );
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass("window-no-drag");
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass(
      "shell-icon-button",
    );
    expect(within(sidebar).getByRole("button", { name: "Set your name" })).toHaveClass(
      "window-no-drag",
    );
    expect(within(sidebar).getByRole("button", { name: "Set your name" })).toHaveClass(
      "sidebar-item",
    );
    for (const button of within(sidebar).getAllByRole("button")) {
      expect(button).toHaveClass("window-no-drag");
    }
    expect(await screen.findByRole("button", { name: "Project actions for Octant" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New thread" })).toBeVisible();
    await user.click(within(sidebar).getByRole("button", { name: "Set your name" }));
    expect(within(sidebar).getByRole("menuitem", { name: "Plugins" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Thread board" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
    const addFolder = screen.getByRole("button", { name: "Add folder" });
    expect(addFolder).toHaveClass("project-section__add");
    expect(addFolder).not.toHaveTextContent("Add folder");
    expect(
      addFolder.compareDocumentPosition(screen.getByRole("heading", { name: "Projects" })),
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    screen.getByRole("button", { name: "Project actions for Octant" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    expect(
      within(screen.getByRole("navigation", { name: "Projects" })).getByText("Relink required"),
    ).toBeVisible();
    await act(async () => {
      codeBootstrap.resolve(readyCodeBootstrap);
      codeThread.resolve(readyCodeThread);
    });
    expect(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "Pull requests",
      }),
    ).toBeVisible();
    expect(await screen.findByRole("button", { name: "New thread" })).toBeVisible();
    expect(
      await screen.findByPlaceholderText("Ask for follow-up changes…", {}, { timeout: 5_000 }),
    ).toBeVisible();

    await openSidebarProject(user, "Octant");
    const overview = await screen.findByRole("region", { name: "Workspace pane: Octant" });
    expect(overview).toBeVisible();
    expect(within(overview).getByText("Relink required")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code");
    expect(projectApi.executeProject).toHaveBeenCalledWith({
      kind: "relink-project",
      projectId,
      expectedVersion: 1,
      receiptId: bindingReceipt,
    });
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");

    // Sidebar Search opens one centered, mode-scoped thread finder.
    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("combobox", { name: "Search Code threads" });
    expect(search).toBeVisible();
    await waitFor(() => expect(search).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Search Code threads" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search Code threads" })).toBeNull();
  }, 15_000);

  it("lists an archived Chat thread the host search reports in the Archived group", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    vi.mocked(chatApi.search).mockResolvedValue([archivedChatThread()]);
    render(
      <App
        chatClient={chatApi}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /Search Chat threads/ }));
    await user.type(screen.getByRole("combobox", { name: "Search Chat threads" }), "Retired");

    // The Chat bootstrap is deliberately active-only, so the Archived group can
    // only ever be filled by the host's own lifecycle-spanning thread search.
    const archived = await screen.findByRole("group", { name: "Archived" });
    expect(within(archived).getByRole("option", { name: /Retired chat/ })).toBeVisible();
    expect(chatApi.search).toHaveBeenCalledWith("Retired");
  });

  it("never reports a loading or unavailable archived listing as an empty Archived group", async () => {
    const user = userEvent.setup();
    const chatApi = chats();
    const pending = deferred<ReadonlyArray<ChatThread>>();
    vi.mocked(chatApi.search).mockReturnValue(pending.promise);
    render(
      <App
        chatClient={chatApi}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
      />,
    );

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /Search Chat threads/ }));
    await user.type(screen.getByRole("combobox", { name: "Search Chat threads" }), "Retired");

    expect(
      await screen.findByText(
        "Archived threads are still loading, so the Archived group may be incomplete.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();

    await act(async () => {
      pending.reject(new Error("Chat search is unavailable."));
      await Promise.resolve();
    });

    expect(
      await screen.findByText(
        "Archived threads are unavailable, so no Archived group can be shown.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching threads.")).toBeNull();
  });

  it("opens a search hit from a non-active Project with the thread's own Project", async () => {
    const user = userEvent.setup();
    const bound = codeShellBootstrap();
    const shellApi = client({
      ...bound,
      workspace: {
        ...bound.workspace,
        contextByMode: {
          ...bound.workspace.contextByMode,
          code: { ...bound.workspace.contextByMode.code, projectId: otherProjectId },
        },
      },
    });
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );

    await user.keyboard("{Control>}k{/Control}");
    await user.click(await screen.findByRole("option", { name: /Search Code threads/ }));
    await user.type(screen.getByRole("combobox", { name: "Search Code threads" }), "Controller");
    await user.click(await screen.findByRole("option", { name: /Controller foundation/ }));

    // The hit's thread lives in "Octant" while this window's Code context is
    // bound to another Project, so the open must carry the thread's Project and
    // dispatch the Project switch rather than a plain open the server-side
    // workspace policy would reject.
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "switch-project-surface",
            mode: "code",
            surface: expect.objectContaining({ threadId: codeThreadId }),
          }),
        }),
      ),
    );
  });

  it("opens a palette thread command from a non-active Project with the thread's own Project", async () => {
    const user = userEvent.setup();
    const bound = codeShellBootstrap();
    const shellApi = client({
      ...bound,
      workspace: {
        ...bound.workspace,
        contextByMode: {
          ...bound.workspace.contextByMode,
          code: { ...bound.workspace.contextByMode.code, projectId: otherProjectId },
        },
      },
    });
    render(
      <App
        chatClient={chats()}
        codeClient={codes()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={shellApi}
      />,
    );
    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });

    await user.keyboard("{Control>}k{/Control}");
    await user.keyboard("Controller");
    await user.click(await screen.findByRole("option", { name: /Open Controller foundation/ }));

    // The palette entry keeps the thread's own Project exactly like a search
    // hit, so the cross-Project open dispatches the Project switch instead of
    // a plain open the server-side workspace policy would reject.
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "switch-project-surface",
            mode: "code",
            surface: expect.objectContaining({ threadId: codeThreadId }),
          }),
        }),
      ),
    );
  });

  it("fails closed when the renderer Project capability is missing", () => {
    render(
      <App launch={{ serverUrl: "http://127.0.0.1:13773", windowId }} shellClient={client()} />,
    );
    expect(
      screen.getByRole("heading", { name: /Project authority is unavailable/i }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code" })).not.toBeInTheDocument();
  });

  it("keeps native picker cancellation and raw paths out of Project creation state", async () => {
    const user = userEvent.setup();
    const projectApi = projects();
    const hostBridge: OctantHostBridge = {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot: vi.fn(async () => ({ kind: "cancelled" as const })),
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
    render(
      <App
        hostBridge={hostBridge}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        shellClient={client()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Add folder" }));
    await user.click(await screen.findByRole("button", { name: "Choose a folder" }));

    await waitFor(() => expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code"));
    expect(projectApi.executeProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create Project" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");
  });

  it("renders the mode welcome for a surface the server restored as layout-only", async () => {
    const restored = codeShellBootstrap();
    const code = restored.workspace.layouts.code;
    if (code.kind !== "pane") throw new Error("default code layout must be a pane");
    // The server restores a pane whose surface no longer resolves as that
    // mode's welcome surface in place, so the renderer only ever receives
    // surfaces it can honestly show.
    const recoveredTab = {
      kind: "welcome" as const,
      id: code.surface.id,
      mode: "code" as const,
      title: "Welcome to Code",
    };
    const recovered: ShellBootstrap = {
      ...restored,
      workspace: {
        ...restored.workspace,
        layouts: {
          ...restored.workspace.layouts,
          code: { ...code, surface: recoveredTab },
        },
      },
    };

    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(recovered)}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Workspace pane: Welcome to Code" }),
    ).toBeVisible();
  });

  it("opens implemented settings and deep-links search results to focused controls", async () => {
    const user = userEvent.setup();
    const providerApi = providers();
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providerApi}
        shellClient={client()}
      />,
    );

    const activePaneId = (
      await screen.findByRole("region", { name: /Workspace pane:/ })
    ).getAttribute("data-workspace-pane-id");
    await openSettingsFromSidebar(user);
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toBeVisible();
    expect(screen.queryByRole("region", { name: /Workspace pane:/ })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-view")).toBeVisible();
    // General is the default section; Chat/Work toggles are visible there.
    expect(screen.getByRole("switch", { name: "Enable Chat" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Work" })).toBeVisible();
    expect(providerApi.bootstrap).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.queryByRole("region", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Workspace pane:/ })).toHaveAttribute(
      "data-workspace-pane-id",
      activePaneId,
    );

    await openSettingsFromSidebar(user);
    await screen.findByRole("searchbox", { name: "Search settings" });

    // Search is navigation: typing "material" shows a result list, and
    // selecting the Translucent sidebar result deep-links to Appearance.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "material");
    const listbox = screen.getByRole("listbox", { name: "Settings search results" });
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.getByRole("switch", { name: "Translucent sidebar" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Enable Chat" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "Settings search results" }),
    ).not.toBeInTheDocument();

    // Search "mode switcher" and deep-link to the control, then mutate it.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "mode switcher");
    const modeListbox = screen.getByRole("listbox", { name: "Settings search results" });
    modeListbox.focus();
    fireEvent.keyDown(modeListbox, { key: "ArrowDown" });
    fireEvent.keyDown(modeListbox, { key: "Enter" });
    const modeSwitcher = screen.getByRole("group", { name: "Mode switcher" });
    await user.click(within(modeSwitcher).getByRole("button", { name: "Buttons" }));
    await user.click(within(modeSwitcher).getByRole("button", { name: "Dropdown" }));
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(await screen.findByRole("button", { name: "Workspace mode, Code" })).toBeVisible();
    await openSettingsFromSidebar(user);
    await screen.findByRole("searchbox", { name: "Search settings" });

    // Search "providers" and deep-link to the Providers & Models section.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "providers");
    const providersListbox = screen.getByRole("listbox", { name: "Settings search results" });
    providersListbox.focus();
    fireEvent.keyDown(providersListbox, { key: "ArrowDown" });
    fireEvent.keyDown(providersListbox, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Providers & Models" })).toBeVisible();
    expect(screen.getByLabelText("Permission persistence")).toHaveValue("current-session");

    // Keyword search still routes to the Providers section.
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "OpenCode");
    const openCodeListbox = screen.getByRole("listbox", { name: "Settings search results" });
    openCodeListbox.focus();
    fireEvent.keyDown(openCodeListbox, { key: "ArrowDown" });
    fireEvent.keyDown(openCodeListbox, { key: "Enter" });
    expect(screen.getByRole("heading", { name: "Providers & Models" })).toBeVisible();
  }, 15_000);

  it("renders recovery-required separately from a disconnected shell", async () => {
    const recoveryClient = client();
    recoveryClient.bootstrap.mockRejectedValueOnce({
      category: "recovery-required",
      message: "Storage recovery is required.",
    });
    const { rerender } = render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={recoveryClient}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Storage recovery required" })).toBeVisible();

    const disconnectedClient = client();
    disconnectedClient.bootstrap.mockRejectedValueOnce({
      category: "unavailable",
      message: "Shell unavailable.",
    });
    rerender(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={disconnectedClient}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Octant is disconnected" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Shell unavailable.");
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry connection" })).toHaveClass(
      "shell-state__action",
    );
  });

  it("opens utilities in the right dock and restores each active thread's selection", async () => {
    const user = userEvent.setup();
    const initial = codeShellBootstrap();
    const firstPane = initial.workspace.layouts.code;
    if (firstPane.kind !== "pane") throw new Error("Expected the Code thread pane.");
    const secondPaneId = "00000000-0000-4000-8000-000000000912" as never;
    const secondThreadId = "30000000-0000-4000-8000-000000000913" as never;
    const split = applyWorkspaceOperation(initial.workspace, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: firstPane.paneId,
      surface: {
        kind: "code-overview",
        id: "00000000-0000-4000-8000-000000000914" as never,
        threadId: secondThreadId,
        mode: "code",
        title: "Second thread",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000915" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000916" as never,
      newPaneId: secondPaneId,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });
    const workspace = applyWorkspaceOperation(split, {
      kind: "open-surface",
      mode: "code",
      paneId: firstPane.paneId,
      surface: firstPane.surface,
    });
    const workspaceWithContext = {
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: {
          ...workspace.contextByMode.code,
          projectId,
          boundRoot: "/Users/example/Dev/Repos/octant",
        },
      },
    } as typeof workspace;
    render(
      <App
        codeClient={codes()}
        contextClient={contextClient()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client({
          ...initial,
          workspace: workspaceWithContext,
          workspaceVersion: workspaceWithContext.version,
        })}
      />,
    );
    await screen.findByRole("region", {
      name: "Workspace pane: Controller foundation",
    });
    const second = screen.getByRole("region", { name: "Workspace pane: Second thread" });

    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    let dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    await user.click(within(dock).getByRole("button", { name: "Browser" }));
    expect(within(dock).getByRole("tab", { name: "Browser" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toHaveAttribute("data-active", "true");
    fireEvent.pointerDown(second);
    await waitFor(() =>
      expect(
        screen.getByRole("banner", { name: "Workspace actions for Second thread" }),
      ).toBeVisible(),
    );
    expect(second).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).not.toHaveAttribute("aria-current");
    await waitFor(() =>
      expect(within(dock).getByText("Open a tool beside the active pane.")).toBeVisible(),
    );
    expect(within(dock).queryByRole("tab", { name: "Browser" })).not.toBeInTheDocument();
    await user.click(within(dock).getByRole("button", { name: "Terminal" }));
    dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.pointerDown(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("banner", { name: "Workspace actions for Controller foundation" }),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(within(dock).getByRole("tab", { name: "Browser" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Workspace pane: Second thread" })).toBeVisible();
  });

  it("moves the active thread Terminal into a remembered bottom panel", async () => {
    window.localStorage.clear();
    const user = userEvent.setup();
    render(
      <App
        codeClient={codes()}
        contextClient={contextClient()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
    await user.click(screen.getByRole("button", { name: "Open bottom panel" }));
    const panel = await screen.findByRole("region", { name: "Bottom panel" });
    expect(within(panel).getByRole("tab", { name: "Terminal" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close bottom panel" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Add tool" }));
    await user.click(within(panel).getByRole("button", { name: "Review" }));
    expect(within(panel).getByRole("tab", { name: "Terminal" })).toBeVisible();
    expect(within(panel).getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(within(panel).getByRole("button", { name: "Hide bottom panel" }));
    expect(screen.queryByRole("region", { name: "Bottom panel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open bottom panel" })).toHaveFocus();
  });

  it("retains the restored Terminal tab when another bottom tool opens", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      `octant.shell.bottom-panel.${String(windowId)}.v1`,
      JSON.stringify({ open: true, height: 260 }),
    );
    const user = userEvent.setup();
    render(
      <App
        codeClient={codes()}
        contextClient={contextClient()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    const panel = await screen.findByRole("region", { name: "Bottom panel" });
    expect(within(panel).getByRole("tab", { name: "Terminal" })).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Add tool" }));
    await user.click(within(panel).getByRole("button", { name: "Review" }));

    expect(within(panel).getByRole("tab", { name: "Terminal" })).toBeVisible();
    expect(within(panel).getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("clears the previous thread's dock tool before a pane with no thread loads", async () => {
    const user = userEvent.setup();
    const initial = codeShellBootstrap();
    const firstPane = initial.workspace.layouts.code;
    if (firstPane.kind !== "pane") throw new Error("Expected the Code thread pane.");
    const projectPaneId = "00000000-0000-4000-8000-000000000918" as never;
    const split = applyWorkspaceOperation(initial.workspace, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: firstPane.paneId,
      surface: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000919" as never,
        projectId,
        mode: "code",
        title: "Octant",
      },
      splitNodeId: "00000000-0000-4000-8000-000000000920" as never,
      newPaneNodeId: "00000000-0000-4000-8000-000000000921" as never,
      newPaneId: projectPaneId,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
    });
    const workspace = applyWorkspaceOperation(split, {
      kind: "open-surface",
      mode: "code",
      paneId: firstPane.paneId,
      surface: firstPane.surface,
    });
    const workspaceWithContext = {
      ...workspace,
      contextByMode: {
        ...workspace.contextByMode,
        code: {
          ...workspace.contextByMode.code,
          projectId,
          boundRoot: "/Users/example/Dev/Repos/octant",
        },
      },
    } as typeof workspace;

    render(
      <App
        codeClient={codes()}
        contextClient={contextClient()}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providersWithToolModel()}
        shellClient={client({
          ...initial,
          workspace: workspaceWithContext,
          workspaceVersion: workspaceWithContext.version,
        })}
      />,
    );

    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    await user.click(within(dock).getByRole("button", { name: "Terminal" }));
    expect(within(dock).getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.pointerDown(screen.getByRole("region", { name: "Workspace pane: Octant" }));

    expect(await within(dock).findByText("Open a tool beside the active pane.")).toBeVisible();
    expect(within(dock).queryByRole("tab", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Workspace pane: Octant" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
  });

  it("opens Review beside the active Code thread from View changes", async () => {
    const user = userEvent.setup();
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environmentForThread).mockResolvedValue(readyEnvironment);
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);
    const codeApi = codes();
    vi.mocked(codeApi.executeOperation).mockImplementation(async (command) => {
      if (command.kind === "observe-git") {
        return {
          kind: "git-observed",
          operationId: command.operationId,
          gitOperationId: command.gitOperationId,
          head: { kind: "branch", name: "feature/editor", oid: "a".repeat(40) },
          stateToken: "b".repeat(64),
          status: [{ path: "src/index.ts", index: " ", worktree: "M" }],
          changedPaths: ["src/index.ts"],
          diff: {
            contentId: "20000000-0000-4000-8000-000000000002",
            digest: "c".repeat(64),
            byteLength: 64,
          },
          remotes: [],
          upstream: null,
          worktrees: [],
        } as never;
      }
      return {
        kind: "operation-failed",
        operationId: command.operationId,
        failure: { message: "no" },
      } as never;
    });
    vi.mocked(codeApi.operationContent).mockResolvedValue(
      new TextEncoder().encode(
        [
          "diff --git a/src/index.ts b/src/index.ts",
          "--- a/src/index.ts",
          "+++ b/src/index.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "",
        ].join("\n"),
      ),
    );

    render(
      <App
        codeClient={codeApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    const thread = await screen.findByRole("region", {
      name: "Workspace pane: Controller foundation",
    });
    await user.click(await screen.findByRole("button", { name: "Toggle environment" }));
    await user.click(await screen.findByRole("button", { name: "View changes" }));

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).getByRole("tab", { name: "Review" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await within(dock).findByRole("navigation", { name: "Changed files" })).toBeVisible();
    expect(thread).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No Code Project open" })).not.toBeInTheDocument();
  });

  it("opens Review in the narrow dock drawer and restores focus when it closes", async () => {
    const user = userEvent.setup();
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" as const }],
    });
    vi.mocked(projectApi.environmentForThread).mockResolvedValue(readyEnvironment);
    vi.mocked(projectApi.environment).mockResolvedValue(readyEnvironment);

    render(
      <App
        codeClient={codes()}
        isNarrow
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(codeShellBootstrap())}
      />,
    );

    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
    const overflow = screen.getByRole("button", { name: "More window actions" });
    await user.click(overflow);
    await user.click(screen.getByRole("button", { name: "Open Right sidebar" }));
    const drawer = await screen.findByRole("dialog", { name: "Right sidebar" });
    await user.click(within(drawer).getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("dialog", { name: "Review" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(overflow).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Review" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Workspace pane: Controller foundation" }),
    ).toBeVisible();
  });
});
