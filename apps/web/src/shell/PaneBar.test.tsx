import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTip, PaneBar } from "./PaneBar";

describe("PaneBar", () => {
  it("names the pane at the left and carries its actions and an info tip at the right", () => {
    render(
      <PaneBar title="Agents">
        <button type="button">Refresh</button>
        <InfoTip text="Subagents run on this computer." />
      </PaneBar>,
    );
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Subagents run on this computer." })).toBeVisible();
  });
});
