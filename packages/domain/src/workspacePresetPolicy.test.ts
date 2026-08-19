import { describe, expect, it } from "vitest";
import { decodeWorkspacePreset } from "@octant/contracts/workspace-presets";
import type { WorkspaceLayoutNode } from "@octant/contracts/shell";
import {
  findWorkspacePresetTarget,
  planWorkspacePreset,
  reportWorkspacePresetSkills,
} from "./workspacePresetPolicy";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const groupId = "20000000-0000-4000-8000-000000000001" as never;

const preset = decodeWorkspacePreset({
  id: "design-studio",
  displayName: "Design studio",
  summary: "The project, a live preview, and a side conversation.",
  mode: "code",
  panes: ["code-overview", "browser", "side-chat"],
  defaultSkills: ["frontend-design", "accessibility-review"],
});

function group(tabs: ReadonlyArray<{ id: string; kind: string }>): WorkspaceLayoutNode {
  return {
    kind: "group",
    nodeId: "30000000-0000-4000-8000-000000000001" as never,
    groupId,
    tabs: tabs.map((tab) => ({
      kind: "code-overview",
      id: tab.id as never,
      threadId,
      mode: "code",
      title: "Release",
    })) as never,
    activeTabId: (tabs[0]?.id ?? "") as never,
  };
}

describe("planWorkspacePreset", () => {
  it("opens every pane the preset pins and leaves the first one in front", () => {
    let minted = 0;
    const operations = planWorkspacePreset({
      preset,
      thread: { threadId, mentionableThreadId: threadId, title: "Release" },
      groupId,
      mintTabId: () => `tab-${++minted}` as never,
    });

    expect(operations.map((operation) => operation.kind)).toEqual([
      "open-tab",
      "open-tab",
      "open-tab",
      "activate-tab",
    ]);
    const opened = operations.filter(
      (operation): operation is Extract<typeof operation, { kind: "open-tab" }> =>
        operation.kind === "open-tab",
    );
    expect(opened.map((operation) => operation.tab.kind)).toEqual([
      "code-overview",
      "browser",
      "side-chat",
    ]);
    const activate = operations.at(-1);
    expect(activate?.kind === "activate-tab" ? activate.tabId : undefined).toBe("tab-1");
  });

  it("opens every pane against the thread the preset was applied to", () => {
    // A pane bound to some other thread would be a preset reaching past the
    // thread it was applied to.
    const operations = planWorkspacePreset({
      preset,
      thread: { threadId, mentionableThreadId: threadId, title: "Release" },
      groupId,
      mintTabId: () => "tab" as never,
    });

    for (const operation of operations) {
      if (operation.kind !== "open-tab") continue;
      const tab = operation.tab;
      const bound =
        "threadId" in tab ? tab.threadId : "sourceThreadId" in tab ? tab.sourceThreadId : undefined;
      expect(bound === undefined || String(bound) === String(threadId)).toBe(true);
      expect(operation.groupId).toBe(groupId);
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
  it("finds the group already showing the thread", () => {
    expect(
      findWorkspacePresetTarget(group([{ id: "a", kind: "code-overview" }]), threadId),
    ).toEqual({ groupId, title: "Release" });
  });

  it("finds nothing for a thread this window does not have open", () => {
    const other = "40000000-0000-4000-8000-000000000009" as never;
    expect(findWorkspacePresetTarget(group([{ id: "a", kind: "code-overview" }]), other)).toBe(
      undefined,
    );
  });

  it("looks through a split layout, not only the group in front", () => {
    const split: WorkspaceLayoutNode = {
      kind: "split",
      nodeId: "50000000-0000-4000-8000-000000000001" as never,
      orientation: "horizontal",
      ratio: 0.5 as never,
      first: {
        kind: "group",
        nodeId: "60000000-0000-4000-8000-000000000001" as never,
        groupId: "70000000-0000-4000-8000-000000000001" as never,
        tabs: [],
        activeTabId: "" as never,
      },
      second: group([{ id: "a", kind: "code-overview" }]),
    };

    expect(findWorkspacePresetTarget(split, threadId)?.groupId).toBe(groupId);
  });
});
