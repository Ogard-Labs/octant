import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatWelcome } from "./ChatWelcome";

describe("ChatWelcome", () => {
  it("starts a conversation from the harness composer", async () => {
    const user = userEvent.setup();
    const onCreateChat = vi.fn();
    render(<ChatWelcome onCreateChat={onCreateChat} />);

    expect(screen.getByRole("heading", { name: "What are you working on?" })).toBeVisible();
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
