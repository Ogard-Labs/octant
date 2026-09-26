import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeProviderModelId,
} from "@octant/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
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

    expect(screen.getByRole("heading", { name: "What’s on your mind?" })).toBeVisible();
    expect(screen.queryByText("Octant Chat")).not.toBeInTheDocument();
    expect(screen.queryByText(/Start a calm, focused conversation/)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "First message" }), "Ship the preview");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onCreateChat).toHaveBeenCalledWith("Ship the preview");
  });

  it("offers the conversations already open and reopens the one chosen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ChatWelcome
        onCreateChat={vi.fn()}
        recentThreads={[{ id: "thread-a", title: "Latency telemetry", onOpen }]}
      />,
    );

    expect(screen.queryByRole("group", { name: "Starter ideas" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Latency telemetry"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps provider and model selection visible in the new Chat composer", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<ChatWelcome onCreateChat={vi.fn()} onOpenSettings={onOpenSettings} />);

    const providerControl = screen.getByRole("button", { name: "Provider and model" });
    expect(providerControl).toHaveTextContent("No provider ready");
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
