import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentHierarchyPanel } from "../agents/AgentHierarchyPanel";
import type { AgentHierarchyInputEntry } from "../agents/buildAgentHierarchyModel";
import { SideChatPanel } from "../chat/SideChatPanel";
import { DeviceToolbar } from "../device/DeviceToolbar";
import { DockBarContext, type DockBarItem, type DockBarPlacement } from "./dockBarControls";

const placements: ReadonlyArray<DockBarPlacement> = ["tiled", "alone", "bottom"];

function hosted(placement: DockBarPlacement, node: React.ReactNode) {
  const handed: (ReadonlyArray<DockBarItem> | undefined)[] = [];
  render(
    <DockBarContext.Provider value={{ placement, set: (items) => handed.push(items) }}>
      {node}
    </DockBarContext.Provider>,
  );
  return () => handed.filter((items) => items !== undefined).at(-1) ?? [];
}

const entry: AgentHierarchyInputEntry = {
  runId: "run-live",
  role: "research",
  task: "Active research",
  lifecycleStatus: "running",
  executionKind: "octant-managed",
  usageQuality: "provider-reported",
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 2,
  updatedAt: "2026-08-01T15:01:00.000Z",
};

describe.each(placements)("a converted tool placed %s", (placement) => {
  it("hands the Agents view switch up in words and draws no heading of its own", () => {
    const onViewChange = vi.fn();
    const items = hosted(
      placement,
      <AgentHierarchyPanel
        creationPosture="automatic"
        entries={[entry]}
        onViewChange={onViewChange}
        view="list"
      />,
    );
    expect(screen.queryByRole("heading", { name: "Subagents" })).toBeNull();
    const choice = items().find((item) => item.kind === "choice");
    expect(choice).toMatchObject({ label: "View", value: "list" });
    if (choice?.kind !== "choice") throw new Error("Expected a view switch.");
    expect(choice.options.map((option) => option.label)).toEqual(["List", "Graph"]);
    choice.onChange("graph");
    expect(onViewChange).toHaveBeenCalledWith("graph");
  });

  it("hands the device's name, state and actions up and draws no toolbar of its own", () => {
    const onKey = vi.fn();
    const items = hosted(
      placement,
      <DeviceToolbar
        controls={{
          hardware: true,
          back: false,
          screenshot: true,
          typeText: false,
          openUrl: false,
          recordScreen: false,
          recording: false,
          rotate: false,
          volume: false,
          switchDevice: false,
          stopLiveView: false,
          shutdown: false,
        }}
        devices={[]}
        dot="running"
        label="Simulator"
        onKey={onKey}
        onMenu={() => {}}
        onScreenshot={() => {}}
        os="iOS 27"
        state="Running"
        title="Phone"
        wide
      />,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(items().map((item) => item.id)).toEqual([
      "device",
      "state",
      "home",
      "screenshot",
      "lock",
      "more",
    ]);
    const home = items().find((item) => item.id === "home");
    if (home?.kind !== "button") throw new Error("Expected Home.");
    home.onSelect();
    expect(onKey).toHaveBeenCalledWith("home");
  });

  it("keeps the Side Chat's own row for what it is about", () => {
    hosted(placement, <SideChatPanel renderSidecar={() => null} sourceTitle="Fix the build" />);
    expect(screen.getByText("About Fix the build")).toBeInTheDocument();
    expect(screen.queryByText(/Side Chat about/)).toBeNull();
  });
});

describe("a converted tool placed where nothing hosts it", () => {
  it("keeps drawing its own header, as a central tab or a page always did", () => {
    render(
      <AgentHierarchyPanel
        creationPosture="automatic"
        entries={[entry]}
        onViewChange={() => {}}
        view="list"
      />,
    );
    expect(screen.getByRole("heading", { name: "Subagents" })).toBeInTheDocument();
    render(<SideChatPanel renderSidecar={() => null} sourceTitle="Fix the build" />);
    expect(screen.getByText("Side Chat about Fix the build")).toBeInTheDocument();
  });
});
