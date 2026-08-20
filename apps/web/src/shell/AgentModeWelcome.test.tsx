import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentModeWelcome } from "./AgentModeWelcome";

describe("AgentModeWelcome", () => {
  it("asks Code to bind a folder, not a repository root", () => {
    render(<AgentModeWelcome mode="code" onAddFolder={vi.fn()} providerReady />);

    expect(screen.getByRole("heading", { name: "Add a folder to start" })).toBeVisible();
    expect(
      screen.getByText(
        "Bind a confined folder for approval-gated coding work. Then start a Code thread with provider, branch, and delivery context.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Select a confined folder on this Mac.")).toBeVisible();
    expect(screen.queryByText(/repository/i)).not.toBeInTheDocument();
  });
});
