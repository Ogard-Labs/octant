import { describe, expect, it } from "vitest";
import { decodeWorkspacePreset } from "@octant/contracts/workspace-presets";
import type { WorkspaceLayoutNode } from "@octant/contracts/shell";
import {
  findWorkspacePresetTarget,
  planWorkspacePreset,
  reportWorkspacePresetSkills,
} from "./workspacePresetPolicy";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const paneId = "20000000-0000-4000-8000-000000000001" as never;

const preset = decodeWorkspacePreset({
  id: "design-studio",
  displayName: "Design studio",
  summary: "The project, a live preview, and a side conversation.",
  mode: "code",
  panes: ["code-overview", "browser", "side-chat"],
  defaultSkills: ["frontend-design", "accessibility-review"],
});

function threadPane(id: string): WorkspaceLayoutNode {
  return {
    kind: "pane",
    nodeId: "30000000-0000-4000-8000-000000000001" as never,
    paneId,
    surface: {
      kind: "code-overview",
      id: id as never,
      threadId,
      mode: "code",
      title: "Release",
    },
  };
}

function planInput() {
  let mintedTabs = 0;
  let mintedPanes = 0;
  let mintedNodes = 0;
  return {
    preset,
    thread: { threadId, mentionableThreadId: threadId, title: "Release" },
    paneId,
    mintTabId: () => `tab-${++mintedTabs}` as never,
    mintPaneId: () => `pane-${++mintedPanes}` as never,
    mintNodeId: () => `node-${++mintedNodes}` as never,
  };
}

describe("planWorkspacePreset", () => {
  it("places the first surface in the thread's pane, splits off the rest, and leaves the first in front", () => {
    const operations = planWorkspacePreset(planInput());

    expect(operations.map((operation) => operation.kind)).toEqual([
      "open-surface",
      "split-pane",
      "split-pane",
      "open-surface",
    ]);
    const surfaces = operations.flatMap((operation) =>
      operation.kind === "open-surface" || operation.kind === "split-pane"
        ? [operation.surface.kind]
        : [],
    );
    expect(surfaces).toEqual(["code-overview", "browser", "side-chat", "code-overview"]);
    // The final open re-activates the lead surface's pane: it is already
    // visible, so nothing new is minted and the lead ends up in front.
    const last = operations.at(-1);
    expect(last?.kind === "open-surface" ? last.surface.id : undefined).toBe("tab-1");
  });

  it("opens every surface against the thread the preset was applied to", () => {
    // A surface bound to some other thread would be a preset reaching past the
    // thread it was applied to.
    const operations = planWorkspacePreset(planInput());

    for (const operation of operations) {
      if (operation.kind !== "open-surface" && operation.kind !== "split-pane") continue;
      const surface = operation.surface;
      const bound =
        "threadId" in surface
          ? surface.threadId
          : "sourceThreadId" in surface
            ? surface.sourceThreadId
            : undefined;
      expect(bound === undefined || String(bound) === String(threadId)).toBe(true);
      if (operation.kind === "open-surface") expect(operation.paneId).toBe(paneId);
      else expect(operation.targetPaneId).toBe(paneId);
    }
  });
});

describe("reportWorkspacePresetSkills", () => {
  it("reports a skill the thread can already use as active", () => {
    expect(
      reportWorkspacePresetSkills(preset, [
        { name: "frontend-design", enabled: true },
        { name: "accessibility-review", enabled: true },
      ]),
    ).toEqual([
      { name: "frontend-design", status: "active" },
      { name: "accessibility-review", status: "active" },
    ]);
  });

  it("reports what is missing instead of enabling it", () => {
    // A preset that could enable a skill would be an installation path that
    // skipped every deliberate step the ladder exists to require.
    expect(
      reportWorkspacePresetSkills(preset, [{ name: "frontend-design", enabled: false }]),
    ).toEqual([
      { name: "frontend-design", status: "installed-not-enabled" },
      { name: "accessibility-review", status: "not-installed" },
    ]);
  });

  it("counts a skill as usable when any installed copy of it is enabled", () => {
    expect(
      reportWorkspacePresetSkills(preset, [
        { name: "frontend-design", enabled: false },
        { name: "frontend-design", enabled: true },
      ])[0],
    ).toEqual({ name: "frontend-design", status: "active" });
  });
});

describe("findWorkspacePresetTarget", () => {
  it("finds the pane already showing the thread", () => {
    expect(findWorkspacePresetTarget(threadPane("a"), threadId)).toEqual({
      paneId,
      title: "Release",
    });
  });

  it("finds nothing for a thread this window does not have open", () => {
    const other = "40000000-0000-4000-8000-000000000009" as never;
    expect(findWorkspacePresetTarget(threadPane("a"), other)).toBe(undefined);
  });

  it("looks through a split layout, not only the pane in front", () => {
    const split: WorkspaceLayoutNode = {
      kind: "split",
      nodeId: "50000000-0000-4000-8000-000000000001" as never,
      orientation: "horizontal",
      ratio: 0.5 as never,
      first: {
        kind: "pane",
        nodeId: "60000000-0000-4000-8000-000000000001" as never,
        paneId: "70000000-0000-4000-8000-000000000001" as never,
        surface: {
          kind: "welcome",
          id: "80000000-0000-4000-8000-000000000001" as never,
          mode: "code",
          title: "Welcome to Code",
        },
      },
      second: threadPane("a"),
    };

    expect(findWorkspacePresetTarget(split, threadId)?.paneId).toBe(paneId);
  });
});
