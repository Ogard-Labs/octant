import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockTiles, type DockTileContent } from "./DockTiles";
import { AgentHierarchyPanel } from "../agents/AgentHierarchyPanel";
import type { AgentHierarchyInputEntry } from "../agents/buildAgentHierarchyModel";
import { SideChatPanel } from "../chat/SideChatPanel";
import { DeviceToolbar } from "../device/DeviceToolbar";
import { DockBarContext, type DockBarItem, type DockBarPlacement } from "./dockBarControls";

const placements: ReadonlyArray<DockBarPlacement> = ["tiled", "alone", "bottom"];

function hosted(placement: DockBarPlacement, node: React.ReactNode) {
  const handed: (ReadonlyArray<DockBarItem> | undefined)[] = [];
  render(
    <DockBarContext.Provider value={{ placement, set: (_owner, items) => handed.push(items) }}>
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
  it("hands the Agents view switch up in words and keeps only a hidden heading", () => {
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
    expect(document.querySelector(".agent-hierarchy__header")).toBeNull();
    expect(screen.getByRole("heading", { name: "Subagents" })).toHaveClass("visually-hidden");
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

const deviceControls = {
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
};

describe("a device's state kept visible in a bar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names each device's system and state under it in the device menu", () => {
    const items = hosted(
      "tiled",
      <DeviceToolbar
        controls={deviceControls}
        currentId="a"
        devices={[
          { id: "a", name: "Phone", os: "iOS 27.0", state: "booted" },
          { id: "b", name: "Tablet", os: "iOS 27.0", state: "shutdown" },
        ]}
        dot="running"
        label="Simulator"
        onKey={() => {}}
        onMenu={() => {}}
        onScreenshot={() => {}}
        onSelectDevice={() => {}}
        state="Running"
        title="Phone"
        wide
      />,
    );
    const choice = items().find((item) => item.kind === "choice");
    if (choice?.kind !== "choice") throw new Error("Expected a device choice.");
    expect(choice.options.map((option) => option.description)).toEqual([
      "iOS 27.0 · Running",
      "iOS 27.0 · Shut down",
    ]);
    const state = items().find((item) => item.id === "state");
    expect(state).toMatchObject({ kind: "text", dot: "running" });
  });

  it("keeps View only in words, and the status dot, when the actions have folded into More", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("dock-tile__bar") ? 280 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return (this.dataset.ruler ?? "").startsWith("text:") ? 90 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("dock-tile__name") ? 40 : 0;
      },
    );
    const onShowApproval = vi.fn();
    const onKey = vi.fn();
    const tool = (
      <DeviceToolbar
        controls={deviceControls}
        devices={[]}
        dot="busy"
        label="Simulator"
        onKey={onKey}
        onMenu={() => {}}
        onScreenshot={() => {}}
        os="iOS 27.0"
        state="Booting"
        title="Phone"
        viewOnly={{ onShowApproval }}
        wide
      />
    );
    const content: DockTileContent = {
      key: "one",
      label: "Simulator",
      surface: "ios-simulator",
      barLeading: <span className="dock-tile__name">Simulator</span>,
      moves: { left: false, right: false, up: false, down: false },
      bodyClassName: "right-utility-dock__tool",
      inset: false,
      children: tool,
    };
    render(
      <DockTiles
        focusedTabId="one"
        layout={{
          columns: [
            { share: 0.5, tiles: [{ tabId: "one", share: 1 }] },
            { share: 0.5, tiles: [{ tabId: "two", share: 1 }] },
          ],
        }}
        onCloseTile={() => {}}
        onFocusTile={() => {}}
        onHideTile={() => {}}
        onMoveTile={() => {}}
        onResizeColumn={() => {}}
        onResizeColumns={() => {}}
        onShowTileAlone={() => {}}
        renderTile={(tabId) =>
          tabId === "one" ? content : { ...content, key: "two", label: "two", children: null }
        }
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Simulator controls" });
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    const chip = within(toolbar).getByRole("button", { name: "View only" });
    expect(chip).toHaveTextContent("View only");
    await userEvent.click(chip);
    expect(onShowApproval).toHaveBeenCalledTimes(1);
    expect(toolbar.querySelector('[data-dot="busy"]')).not.toBeNull();
    await userEvent.click(within(toolbar).getByRole("button", { name: "More Simulator actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Home" }));
    expect(onKey).toHaveBeenCalledWith("home");
  });
});
