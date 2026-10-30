import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
} from "@octant/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import {
  createNewTaskDrafts,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
} from "../composer/useNewTaskPrompt";
import { ChatWelcome } from "./ChatWelcome";

describe("ChatWelcome", () => {
  it("submits the reasoning level chosen before the first message", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    const providerId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000001");
    const modelId = decodeProviderModelId("reasoning-model");
    const { rerender } = render(
      <ChatWelcome
        onCreateChat={onCreateChat}
        selectedProviderInstanceId={providerId}
        selectedModelId={modelId}
        providerGroups={[
          {
            instance: decodeProviderInstance({
              id: providerId,
              displayName: "Codex",
              driverKind: "codex",
              configuration: { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
              enabled: true,
              environmentPolicy: "inherit-host",
              version: 1,
              createdAt: "2026-09-16T00:00:00.000Z",
              updatedAt: "2026-09-16T00:00:00.000Z",
            }),
            runtime: "provider",
            readiness: "ready",
            driverLabel: "Codex CLI",
            endpointHost: undefined,
            executionHost: "This computer",
            sections: [
              {
                id: "all-models",
                label: "Models",
                models: [
                  {
                    badges: [],
                    toolCapable: true,
                    model: {
                      id: modelId,
                      displayName: "Reasoning model",
                      source: "discovered",
                      verification: "verified",
                      reasoning: "supported",
                      inputModalities: ["text"],
                      options: [
                        {
                          kind: "selection",
                          id: "effort",
                          displayName: "Effort",
                          values: ["low", "high"],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const effort = screen.getByRole("slider", { name: "Effort level" });
    fireEvent.change(effort, { target: { value: "2" } });
    expect(effort).toHaveAttribute("aria-valuetext", "High");
    await user.keyboard("{Escape}");
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledWith("Hello", { effort: "high" });

    onCreateChat.mockClear();
    rerender(
      <ChatWelcome
        onCreateChat={onCreateChat}
        selectedProviderInstanceId={providerId}
        selectedModelId={decodeProviderModelId("other-model")}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledExactlyOnceWith("Hello");
    onCreateChat.mockClear();
    rerender(
      <ChatWelcome
        onCreateChat={onCreateChat}
        selectedProviderInstanceId={providerId}
        selectedModelId={modelId}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledExactlyOnceWith("Hello");
  });

  it("sends a first message that names @computer as plain text", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    render(<ChatWelcome onCreateChat={onCreateChat} />);

    await user.type(
      screen.getByRole("textbox", { name: "First message" }),
      "@computer describe my screen",
    );
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledWith("@computer describe my screen");
  });

  it("opens the host command list from Chat's first-message composer", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <OctantCommandProvider
        commands={[
          {
            id: "settings:open",
            title: "Open Settings",
            group: "Settings",
            action: { kind: "run", run: onOpenSettings },
          },
        ]}
      >
        <ChatWelcome onCreateChat={vi.fn()} />
      </OctantCommandProvider>,
    );

    const draft = screen.getByRole("textbox", { name: "First message" });
    await user.type(draft, "/");
    const list = screen.getByRole("listbox", { name: "Commands you can run" });
    expect(within(list).getByRole("option", { name: /Open Settings/ })).toBeVisible();
    await user.click(within(list).getByRole("option", { name: /Open Settings/ }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(draft).toHaveValue("");
  });

  it("starts a conversation from the harness composer", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    render(<ChatWelcome onCreateChat={onCreateChat} />);

    expect(screen.getByRole("heading", { name: "What are we building today?" })).toBeVisible();
    expect(screen.queryByText("Octant Chat")).not.toBeInTheDocument();
    expect(screen.queryByText(/Start a calm, focused conversation/)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Ship the preview");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledWith("Ship the preview");
  });

  it("lists no recent threads and offers starter ideas only while there are none", () => {
    const first = render(<ChatWelcome onCreateChat={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Starter ideas" })).toBeVisible();
    first.unmount();

    render(
      <ChatWelcome
        onCreateChat={vi.fn()}
        recentThreads={[{ id: "thread-a", title: "Latency telemetry", onOpen: vi.fn() }]}
      />,
    );
    expect(screen.queryByText("Latency telemetry")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Starter ideas" })).not.toBeInTheDocument();
  });

  it("keeps the first-message draft after the welcome remounts", async () => {
    const user = userEvent.setup();
    const drafts = createNewTaskDrafts();
    function view() {
      return (
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value="chat-welcome:test">
            <ChatWelcome onCreateChat={vi.fn()} />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      );
    }

    const rendered = render(view());
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Keep this draft");
    rendered.unmount();
    render(view());

    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue("Keep this draft");
  });

  it("keeps provider and model selection visible in the new Chat composer", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<ChatWelcome onCreateChat={vi.fn()} onOpenSettings={onOpenSettings} />);

    const providerControl = screen.getByRole("button", { name: "Set up a provider" });
    expect(providerControl).toBeEnabled();
    await user.click(providerControl);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("offers quiet starter categories that prepare a draft without sending it", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    render(<ChatWelcome onCreateChat={onCreateChat} />);

    await user.click(screen.getByRole("button", { name: "Learn" }));

    expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
      "Explain a concept clearly, then check my understanding.",
    );
    expect(screen.getByRole("textbox", { name: "First message" })).toHaveFocus();
    expect(onCreateChat).not.toHaveBeenCalled();
  });

  it("keeps the attach control reachable and explains that attachments come after the chat starts", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    render(<ChatWelcome onCreateChat={onCreateChat} />);

    await user.click(screen.getByRole("button", { name: "Add attachment" }));

    expect(
      await screen.findByText("Attachments can be added once the chat starts.", {
        selector: 'p[role="status"]',
      }),
    ).toBeVisible();
    expect(onCreateChat).not.toHaveBeenCalled();
  });

  it("disables creation and surfaces a retry path while Chat is disconnected", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    const onRetry = vi.fn();
    render(
      <ChatWelcome
        errorMessage="Chat is disconnected."
        onCreateChat={onCreateChat}
        onRetry={onRetry}
        status="disconnected"
      />,
    );

    expect(screen.getByRole("button", { name: "Start chat" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Chat is disconnected.");
    await user.click(screen.getByRole("button", { name: "Retry Chat" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCreateChat).not.toHaveBeenCalled();
  });
});
