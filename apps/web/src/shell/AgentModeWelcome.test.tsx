import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentModeWelcome } from "./AgentModeWelcome";

describe("AgentModeWelcome", () => {
  it("asks for a folder in plain words and leads with choosing one", async () => {
    const onAddFolder = vi.fn();
    render(
      <AgentModeWelcome
        mode="work"
        onAddFolder={onAddFolder}
        onOpenDraft={vi.fn()}
        providerReady
      />,
    );

    expect(screen.getByRole("heading", { name: "Pick a folder to work in" })).toBeVisible();
    expect(screen.queryByText(/confined|harness|bind/i)).not.toBeInTheDocument();
    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveTextContent("Choose a folder…");
    expect(second).toHaveTextContent("Start without a folder");
    await userEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    expect(onAddFolder).toHaveBeenCalledOnce();
  });

  it("asks Code for a folder, not a repository root", () => {
    render(<AgentModeWelcome mode="code" onAddFolder={vi.fn()} providerReady />);

    expect(screen.getByRole("heading", { name: "Pick a folder to code in" })).toBeVisible();
    expect(screen.queryByText(/repository/i)).not.toBeInTheDocument();
  });

  it("leads with a new task once a Project is bound, and keeps adding a folder second", () => {
    render(
      <AgentModeWelcome
        hasProjects
        mode="code"
        onAddFolder={vi.fn()}
        onOpenDraft={vi.fn()}
        providerReady
      />,
    );

    expect(screen.getByRole("heading", { name: "Start a Code thread" })).toBeVisible();
    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveTextContent("Start a new thread");
    expect(second).toHaveTextContent("Add another folder");
  });
});
