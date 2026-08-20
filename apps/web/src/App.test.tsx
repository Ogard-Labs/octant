import {
  decodeWorkThread,
  type ShellBootstrap,
  type ProjectBootstrap,
  type ProviderRegistryCommand,
  type ProviderRegistryCommandResult,
} from "@octant/contracts";
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
    await user.click(screen.getByRole("button", { name: "Plugins" }));

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
    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          tab: expect.objectContaining({
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
        shellApi.execute.mock.calls[index]?.[0].operation.kind === "open-tab" &&
        shellApi.execute.mock.calls[index]?.[0].operation.tab.kind === "chat-thread",
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
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const projectWorkspace = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
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
            kind: "switch-project-tab",
            mode: "chat",
            tab: expect.objectContaining({
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
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const shellApi = client({
      ...initial,
      workspace: applyWorkspaceOperation(initial.workspace, {
        kind: "open-tab",
        mode: "chat",
        groupId: layout.groupId,
        tab: {
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

    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
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

    expect(await screen.findByRole("tab", { name: "Exact created chat" })).toBeVisible();
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
    expect(await screen.findByRole("tab", { name: "Draft brief" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          mode: "work",
          tab: expect.objectContaining({
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
    expect(screen.queryByRole("tab", { name: "Keep this overview draft" })).toBeNull();
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
    expect(await screen.findByRole("tab", { name: "Release checklist" })).toBeVisible();
    expect(shellApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "open-tab",
          mode: "work",
          tab: expect.objectContaining({
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

  it("follows the active Project with the live Context client and renders the authoritative inspector", async () => {
    const user = userEvent.setup();
    const contextApi: ContextClient = {
      inspect: vi.fn(async ({ subject }) => {
        const snapshot = contextFixture();
        return {
          ...snapshot,
          subject,
          displayLabel: "Octant",
          next: {
            ...snapshot.next,
            manifest: { ...snapshot.next.manifest, subject },
          },
          latestSent: {
            ...snapshot.latestSent!,
            manifest: { ...snapshot.latestSent!.manifest, subject },
          },
          capacity: { ...snapshot.capacity!, subject },
        } as never;
      }),
      execute: vi.fn(),
    };
    const projectApi = projects({
      ...projectBootstrap(),
      availability: [{ ...projectBootstrap().availability[0]!, status: "available" }],
    });

    render(
      <App
        contextClient={contextApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projectApi}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    await waitFor(() =>
      expect(contextApi.inspect).toHaveBeenCalledWith(
        {
          subject: { aggregateType: "project", aggregateId: projectId },
        },
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole("button", { name: /Open context inspector for Octant/i }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Context" }));
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(within(dock).getByRole("heading", { name: "Context inspector" })).toBeVisible();
    expect(within(dock).getByText("Safe input budget")).toBeVisible();
    expect(within(dock).getByText("Provider capacity")).toBeVisible();
  });

  it("keeps a context warning visible after its Project tab loses focus", async () => {
    const user = userEvent.setup();
    const contextApi: ContextClient = {
      inspect: vi.fn(async ({ subject }) => {
        const snapshot = contextFixture();
        return {
          ...snapshot,
          subject,
          next: {
            ...snapshot.next,
            manifest: { ...snapshot.next.manifest, subject },
            plan: { ...snapshot.next.plan, health: "watch" },
          },
          latestSent: {
            ...snapshot.latestSent!,
            manifest: { ...snapshot.latestSent!.manifest, subject },
          },
          capacity: { ...snapshot.capacity!, subject },
        } as never;
      }),
      execute: vi.fn(),
    };
    const value = projectBootstrap();
    const secondProject = { ...value.active[0]!, id: otherProjectId, name: "Other Repository" };

    render(
      <App
        contextClient={contextApi}
        isNarrow={false}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects({
          ...value,
          active: [...value.active, secondProject],
          availability: [
            { ...value.availability[0]!, status: "available" },
            { ...value.availability[0]!, projectId: otherProjectId, status: "available" },
          ],
        })}
        projectWindowCapability={projectWindowCapability}
        shellClient={client()}
      />,
    );

    await openSidebarProject(user, "Octant");
    expect(
      await screen.findByRole("button", {
        name: "Octant: Watch. Open context inspector.",
      }),
    ).toBeVisible();
    await openSidebarProject(user, "Other Repository");

    const warning = screen.getByRole("button", {
      name: "Octant: Watch. Open context inspector.",
    });
    expect(warning).toBeVisible();
    expect(screen.getByRole("tab", { name: "Octant" })).toHaveAttribute("aria-selected", "false");
    await user.click(warning);
    expect(await screen.findByRole("heading", { name: "Context inspector" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Octant" })).toHaveAttribute("aria-selected", "true");
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
    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
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

    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
    expect(screen.queryByRole("separator", { name: "Resize navigation sidebar" })).toBeNull();
    expect(document.querySelector(".shell")).toHaveStyle({ "--octant-sidebar-width": "320px" });
  });

  it("uses one validated Right Utility Dock host for the Project's own surfaces", async () => {
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

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByText("Keep this Project's memory visible.")).toBeVisible();
    expect(document.querySelectorAll("#right-utility-dock")).toHaveLength(1);
    expect(document.querySelector("#environment-hub, #context-sidebar")).toBeNull();
    // The dock answers for a Project, so it never repeats the thread's own
    // environment: that lives beside the thread it describes.
    expect(within(dock).queryByText(readyEnvironment.repositoryRoot)).toBeNull();
    expect(within(dock).queryByRole("button", { name: "Code environment" })).toBeNull();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);

    await openSidebarProject(user, "Other Repository");
    expect(screen.getByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.getByText("Keep this Project's memory visible.")).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledTimes(1);
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
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const withFirstProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000883" as never,
        projectId,
        mode: "chat",
        title: "Project Alpha",
      },
    });
    const withBothProjects = applyWorkspaceOperation(withFirstProject, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
        kind: "project",
        id: "00000000-0000-4000-8000-000000000884" as never,
        projectId: otherProjectId,
        mode: "chat",
        title: "Project Beta",
      },
    });
    const splitProjects = applyWorkspaceOperation(withBothProjects, {
      kind: "split-group",
      mode: "chat",
      groupId: layout.groupId,
      tabId: "00000000-0000-4000-8000-000000000884" as never,
      splitNodeId: "00000000-0000-4000-8000-000000000885" as never,
      newGroupNodeId: "00000000-0000-4000-8000-000000000886" as never,
      newGroupId: "00000000-0000-4000-8000-000000000887" as never,
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
    const reviewAlphaMemory = await within(alphaProject).findByRole("button", {
      name: "Review memory",
    });
    vi.mocked(projectApi.memory).mockClear();
    await user.click(reviewAlphaMemory);

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByText("Project Alpha")).toBeVisible();
    await waitFor(() => expect(projectApi.memory).toHaveBeenCalledWith(projectId));

    const betaOverview = screen.getByDisplayValue("Project Beta").closest(".project-overview");
    if (!(betaOverview instanceof HTMLElement)) throw new Error("Expected Project Beta overview.");
    await user.click(within(betaOverview).getByRole("button", { name: "Review memory" }));

    expect(await within(dock).findByText("Project Beta")).toBeVisible();
    expect(within(dock).getByRole("button", { name: "Add memory" })).toBeDisabled();
    expect(within(dock).queryByText("Memory 1")).not.toBeInTheDocument();

    betaMemory.resolve({ projectId: otherProjectId, active: [], history: [] } as never);
    await waitFor(() =>
      expect(within(dock).getByRole("button", { name: "Add memory" })).toBeEnabled(),
    );
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
    if (layout.kind !== "group") throw new Error("Expected the default Chat group.");
    const withProject = applyWorkspaceOperation(initial.workspace, {
      kind: "open-tab",
      mode: "chat",
      groupId: layout.groupId,
      tab: {
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

    expect(await screen.findByRole("tab", { name: "Older chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the owning Code Project active while a Code thread tab is selected", async () => {
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
      await screen.findByRole("heading", { name: "Controller foundation" }, { timeout: 5_000 }),
    ).toBeVisible();
    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(
      await within(dock).findByRole("button", { name: "Project memory", pressed: true }),
    ).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);
  });

  it("restores the saved dock surface for the active Project after restart", async () => {
    const user = userEvent.setup();
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "group") throw new Error("Default Code layout must be a group.");
    const restoredWorkspace = applyWorkspaceOperation(initial, {
      kind: "open-tab",
      mode: "code",
      groupId: code.groupId,
      tab: {
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

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(
      await within(dock).findByRole("button", { name: "Project memory", pressed: true }),
    ).toBeVisible();
    expect(projectApi.memory).toHaveBeenCalledWith(projectId);
    await user.click(screen.getByRole("button", { name: "Close Project memory" }));
    await waitFor(() =>
      expect(shellApi.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "replace-settings",
          settings: expect.objectContaining({ lastContextSurface: null }),
        }),
      ),
    );
  });

  it("keeps Project context and the Right Utility Dock on the active split group", async () => {
    const initial = codeShellBootstrap().workspace;
    const code = initial.layouts.code;
    if (code.kind !== "group") throw new Error("Default Code layout must be a group.");
    const projectTabId = "00000000-0000-4000-8000-000000000631" as never;
    const withProject = applyWorkspaceOperation(initial, {
      kind: "open-tab",
      mode: "code",
      groupId: code.groupId,
      tab: {
        kind: "project",
        id: projectTabId,
        projectId,
        mode: "code",
        title: "Octant",
      },
    });
    const withSplitProject = applyWorkspaceOperation(withProject, {
      kind: "split-group",
      mode: "code",
      groupId: code.groupId,
      tabId: projectTabId,
      splitNodeId: "00000000-0000-4000-8000-000000000632" as never,
      newGroupNodeId: "00000000-0000-4000-8000-000000000633" as never,
      newGroupId: "00000000-0000-4000-8000-000000000634" as never,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5 as never,
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

    expect(await screen.findByRole("button", { name: "Open Context" })).toBeVisible();
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
    const opener = screen.getByRole("button", { name: "Review Project memory" });
    await user.click(opener);

    expect(await screen.findByRole("dialog", { name: "Project memory" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(document.querySelectorAll(".octant-dialog__backdrop")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__viewport")).toHaveLength(1);
    expect(document.querySelectorAll(".octant-dialog__popup")).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: "Project memory" })).toBeNull();
  });

  it("does not disclose Code environment for Chat, Work, or no active Project", async () => {
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

    expect(await screen.findByRole("button", { name: "Code" })).toBeVisible();
    await openSidebarProject(user, "Octant");
    expect(screen.getByRole("button", { name: "Open Context" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Code environment" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review Project memory" }));
    expect(await screen.findByRole("complementary", { name: "Right Utility Dock" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Code environment" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.queryByRole("complementary", { name: "Right Utility Dock" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Code environment/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.queryByRole("button", { name: /Code environment/i })).not.toBeInTheDocument();
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
    expect(
      screen.getByRole("status", { name: /^Host: This Mac · (Connected|Connecting)$/ }),
    ).toBeVisible();
    expect(document.querySelector(".window-chrome__identity")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Welcome to Chat" })).toBeVisible();
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

    await screen.findByRole("tab", { name: "Welcome to Chat" });
    await waitFor(() => expect(subscribeStartNewAgent).toHaveBeenCalled());
    await act(async () => startNewAgent?.());
    await waitFor(() =>
      expect(
        shellApi.execute.mock.calls.some(
          ([command]) =>
            command.kind === "apply-workspace-operation" &&
            command.operation.kind === "open-tab" &&
            command.operation.mode === "chat" &&
            command.operation.tab.kind === "draft-thread",
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
            command.operation.kind === "open-tab" &&
            command.operation.tab.kind === "project" &&
            String(command.operation.tab.projectId) === String(projectId),
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      shellApi.execute.mock.calls.filter(
        ([command]) =>
          command.kind === "apply-workspace-operation" &&
          command.operation.kind === "open-tab" &&
          command.operation.tab.kind === "project",
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
            command.operation.kind === "open-tab" &&
            command.operation.tab.kind === "code-overview" &&
            String(command.operation.tab.threadId) === String(codeThreadId),
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
          command.operation.kind === "open-tab" &&
          command.operation.tab.kind === "code-overview" &&
          String(command.operation.tab.threadId) === String(codeThreadId),
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
    expect(await screen.findByRole("button", { name: "Code" })).toHaveAttribute(
      "aria-current",
      "page",
    );
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
    expect(within(sidebar).getByRole("group", { name: "Workspace mode" })).toHaveClass(
      "window-no-drag",
    );
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass("window-no-drag");
    expect(within(sidebar).getByRole("button", { name: "Search" })).toHaveClass("btn-icon");
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
    expect(screen.getByRole("button", { name: "Plugins" })).toBeVisible();
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
    expect(screen.getByText("Relink required")).toBeVisible();
    await act(async () => {
      codeBootstrap.resolve(readyCodeBootstrap);
      codeThread.resolve(readyCodeThread);
    });
    expect(await screen.findByRole("button", { name: /Pull requests/i })).toBeVisible();
    expect(await screen.findByRole("button", { name: "New thread" })).toBeVisible();
    expect(
      await screen.findByPlaceholderText("Ask for follow-up changes…", {}, { timeout: 5_000 }),
    ).toBeVisible();

    await openSidebarProject(user, "Octant");
    expect(await screen.findByRole("tab", { name: "Octant" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Relink required");
    await user.click(screen.getByRole("button", { name: "Choose new root" }));
    expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code");
    expect(projectApi.executeProject).toHaveBeenCalledWith({
      kind: "relink-project",
      projectId,
      expectedVersion: 1,
      receiptId: bindingReceipt,
    });
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");

    // Sidebar Search is in-place: it names the active mode so a user can
    // never mistake which set is listed. The overlay is a separate palette
    // finder, not this control.
    await user.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("searchbox", { name: "Search Code threads" });
    expect(search).toBeVisible();
    expect(search).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Search Code threads" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox", { name: "Search Code threads" })).toBeNull();
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
            kind: "switch-project-tab",
            mode: "code",
            tab: expect.objectContaining({ threadId: codeThreadId }),
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
    await screen.findByRole("heading", { name: "Controller foundation" });

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
            kind: "switch-project-tab",
            mode: "code",
            tab: expect.objectContaining({ threadId: codeThreadId }),
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

    await waitFor(() => expect(hostBridge.selectProjectRoot).toHaveBeenCalledWith("code"));
    expect(projectApi.executeProject).not.toHaveBeenCalled();
    expect(screen.getByText("Project creation cancelled.")).toBeVisible();
    expect(document.body).not.toHaveTextContent("/private/unvalidated-selection");
  });

  it("renders an unavailable placeholder restored by the server bootstrap", async () => {
    const restored = codeShellBootstrap();
    const code = restored.workspace.layouts.code;
    if (code.kind !== "group") throw new Error("default code layout must be a group");
    const recoveredTab = {
      kind: "unavailable" as const,
      id: code.tabs[0]!.id,
      title: "Recovered editor",
      reason: "This tab type is unavailable in this version of Octant.",
    };
    const recovered: ShellBootstrap = {
      ...restored,
      workspace: {
        ...restored.workspace,
        layouts: {
          ...restored.workspace.layouts,
          code: { ...code, tabs: [recoveredTab], activeTabId: recoveredTab.id },
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

    expect(await screen.findByRole("heading", { name: "Recovered editor" })).toBeVisible();
    expect(
      screen.getByText("This tab type is unavailable in this version of Octant."),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Recovered editor" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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

    const activeTabId = (await screen.findByRole("tab", { selected: true })).getAttribute(
      "data-workspace-tab-id",
    );
    await openSettingsFromSidebar(user);
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Settings sidebar" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Welcome to Chat" })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-view")).toBeVisible();
    // General is the default section; Chat/Work toggles are visible there.
    expect(screen.getByRole("switch", { name: "Enable Chat" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Work" })).toBeVisible();
    expect(providerApi.bootstrap).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back to app" }));
    expect(screen.queryByRole("region", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { selected: true })).toHaveAttribute(
      "data-workspace-tab-id",
      activeTabId,
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
    await user.selectOptions(screen.getByLabelText("Mode switcher"), "dropdown");
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

  it("re-announces the same keyboard action with a monotonically newer live event", async () => {
    const user = userEvent.setup();
    render(
      <App
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        shellClient={client(bootstrap())}
      />,
    );
    const tab = await screen.findByRole("tab", { name: "Welcome to Chat" });
    tab.focus();
    await user.keyboard("{Enter}");
    const liveRegion = document.querySelector('[aria-live="polite"]');
    await waitFor(() => expect(liveRegion).toHaveAttribute("data-announcement-sequence", "1"));
    expect(liveRegion).toHaveClass("sr-only");
    expect(liveRegion).toHaveStyle({ position: "absolute", width: "1px" });
    expect(liveRegion).toHaveTextContent("Tab activated. Event 1.");
    expect(screen.getByText("Event 1.")).toHaveStyle({ position: "absolute", width: "1px" });

    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveRegion).toHaveAttribute("data-announcement-sequence", "2"));
    expect(liveRegion).toHaveTextContent("Tab activated.");
  });
});
