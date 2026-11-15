import { decodeScaffoldEntry } from "@octant/contracts/scaffolds";
import { decodeWorkspacePreset } from "@octant/contracts/workspace-presets";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScaffoldPicker } from "../scaffolds/ScaffoldPicker";
import { WorkspacePresetPicker } from "../workspacePresets/WorkspacePresetPicker";
import { EmptyThreadStart } from "./EmptyThreadStart";

const preset = decodeWorkspacePreset({
  id: "design-studio",
  displayName: "Design studio",
  summary: "A browser, an overview and a side chat for design work.",
  mode: "code",
  panes: ["code-overview", "browser", "side-chat"],
  defaultSkills: [],
});

const template = decodeScaffoldEntry({
  id: "native-apple-app",
  displayName: "Native Swift package",
  summary: "A Swift package the Apple toolchain builds directly.",
  target: "native-apple-app",
  generator: {
    kind: "toolchain",
    tool: "swift",
    presetArguments: ["package", "init", "--type", "executable"],
  },
  requiresTool: "swift",
  produces: ["Package.swift"],
});

function block(title: string | undefined) {
  return render(
    <EmptyThreadStart title={title}>
      <WorkspacePresetPicker busy={false} onApply={vi.fn()} presets={[preset]} skills={[]} />
      <ScaffoldPicker
        busy={false}
        entries={[template]}
        onStart={vi.fn()}
        runnable={new Map([["native-apple-app", false]])}
      />
    </EmptyThreadStart>,
  );
}

describe("an empty thread's start block", () => {
  it("holds both labelled groups on one surface under the thread's title", () => {
    const { container } = block("Fix the login redirect");

    expect(screen.getByRole("heading", { name: "Fix the login redirect" })).toBeVisible();
    const surfaces = container.querySelectorAll(".empty-start__surface");
    expect(surfaces).toHaveLength(1);
    const surface = surfaces.item(0) as HTMLElement;
    const groups = within(surface).getAllByRole("region");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Set up this workspace",
      "Start from a template",
    ]);
    expect(within(surface).getByRole("heading", { name: "Start from a template" })).toHaveClass(
      "oct-section-label",
    );
  });

  it("names a thread without a title as one to start", () => {
    block(undefined);

    expect(screen.getByRole("heading", { name: "Start this thread" })).toBeVisible();
  });

  it("carries the reason a template cannot run on its own row", () => {
    block("A thread");

    expect(screen.getByRole("button", { name: /Native Swift package/ })).toHaveTextContent(
      "Needs swift, which is not on this machine.",
    );
  });
});
