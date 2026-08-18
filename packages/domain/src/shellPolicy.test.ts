import {
  decodeLayoutNodeId,
  decodeTabGroupId,
  decodeWindowId,
  decodeWorkspaceOperation,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type ShellSettings,
  type TabGroupId,
  type WindowWorkspace,
  type WorkspaceLayoutNode,
} from "@octant/contracts/shell";
import type { CodeEnvironmentObservation } from "@octant/contracts";
import { decodeCodeEnvironmentObservation, decodeWorkThreadId } from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import {
  MAX_LAYOUT_DEPTH,
  MAX_TAB_GROUPS,
  MAX_WORKSPACE_TABS,
  ShellPolicyRejected,
  WorkspaceContextRejected,
  applyWorkspaceOperation,
  buildCompactIdentity,
  defaultEnvironmentPresentationState,
  defaultShellSettings,
  defaultWindowWorkspace,
  deriveChatEnvironmentProjection,
  deriveCodeEnvironmentProjection,
  deriveWorkEnvironmentProjection,
  filterEnvironmentSections,
  normalizeEnvironmentPresentationState,
  reconcileWorkspaceWithSettings,
  removeEnvironmentPresentation,
  replaceEnvironmentPresentation,
  replaceShellSettings,
  resolveFirstRunOnboarding,
  resolveEffectivePresentation,
  resolveEnvironmentPinnedWidth,
  resolveSurfaceDescriptors,
  resolveWorkspaceContext,
  validateWorkspace,
} from "./shellPolicy";

const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-000000000001"),
  tabA: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000101"),
  tabB: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000102"),
  tabC: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000103"),
  groupA: decodeTabGroupId("00000000-0000-4000-8000-000000000201"),
  groupB: decodeTabGroupId("00000000-0000-4000-8000-000000000202"),
  nodeA: decodeLayoutNodeId("00000000-0000-4000-8000-000000000301"),
  nodeB: decodeLayoutNodeId("00000000-0000-4000-8000-000000000302"),
  splitA: decodeLayoutNodeId("00000000-0000-4000-8000-000000000401"),
  splitB: decodeLayoutNodeId("00000000-0000-4000-8000-000000000402"),
  nodeC: decodeLayoutNodeId("00000000-0000-4000-8000-000000000303"),
  groupC: decodeTabGroupId("00000000-0000-4000-8000-000000000203"),
  project: decodeProjectId("00000000-0000-4000-8000-000000000501"),
  thread: decodeChatThreadId("00000000-0000-4000-8000-000000000601"),
  codeThread: decodeCodeThreadId("00000000-0000-4000-8000-000000000602"),
};

const tab = (id = ids.tabA, kind: "welcome" | "unavailable" = "welcome") =>
  decodeWorkspaceTab(
    kind === "welcome"
      ? { kind, id, mode: "code", title: `Tab ${id.slice(-3)}` }
      : { kind, id, title: `Tab ${id.slice(-3)}`, reason: "Temporarily missing" },
  );

function onlyGroup(layout: WorkspaceLayoutNode) {
  expect(layout.kind).toBe("group");
  if (layout.kind !== "group") throw new Error("expected group");
  return layout;
}

function codeGroup(workspace: WindowWorkspace) {
  return onlyGroup(workspace.layouts.code);
}

describe("Code tab mode authority", () => {
  it("accepts Code tabs only in the Code layout", () => {
    const codeTab = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabA,
      threadId: ids.codeThread,
      mode: "code",
      title: "Overview",
    });
    const workspace = defaultWindowWorkspace(ids.window);
    const code = codeGroup(workspace);
    expect(
      validateWorkspace({
        ...workspace,
        layouts: {
          ...workspace.layouts,
          code: { ...code, tabs: [codeTab], activeTabId: codeTab.id },
        },
      }),
    ).toBeDefined();

    const chat = onlyGroup(workspace.layouts.chat);
    expect(() =>
      validateWorkspace({
        ...workspace,
        layouts: {
          ...workspace.layouts,
          chat: { ...chat, tabs: [codeTab], activeTabId: codeTab.id },
        },
      }),
    ).toThrow(ShellPolicyRejected);
  });
});

function firstGroupId(layout: WorkspaceLayoutNode): TabGroupId {
  return layout.kind === "group" ? layout.groupId : firstGroupId(layout.first);
}

function codeLayoutWithGroups(groupCount: number): WorkspaceLayoutNode {
  const groups: ReadonlyArray<WorkspaceLayoutNode> = Array.from(
    { length: groupCount },
    (_, index) => {
      const tabId = decodeWorkspaceTabId(
        `a3000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      return {
        kind: "group",
        nodeId: decodeLayoutNodeId(`a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        groupId: decodeTabGroupId(`a2000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        tabs: [tab(tabId)],
        activeTabId: tabId,
      };
    },
  );
  const join = (nodes: ReadonlyArray<WorkspaceLayoutNode>): WorkspaceLayoutNode =>
    nodes.length === 1
      ? nodes[0]!
      : {
          kind: "split",
          nodeId: decodeLayoutNodeId(
            `a4000000-0000-4000-8000-${String(nodes.length).padStart(12, "0")}`,
          ),
          orientation: "horizontal",
          ratio: 0.5,
          first: nodes[0]!,
          second: join(nodes.slice(1)),
        };
  return join(groups);
}

describe("shell settings policy", () => {
  it("provides defaults and clamps replacement widths without mutating current settings", () => {
    const current = defaultShellSettings();
    const replacement: ShellSettings = {
      ...current,
      chatEnabled: false,
      workEnabled: false,
      sidebarWidth: 999,
      contextSidebarWidth: 999,
      lastContextSurface: "code-environment",
      modeSwitcherPresentation: "dropdown",
    };

    expect(current).toEqual({
      chatEnabled: true,
      workEnabled: true,
      sidebarWidth: 232,
      contextSidebarWidth: 360,
      lastContextSurface: null,
      sidebarMaterial: "system",
      modeSwitcherPresentation: "buttons",
      projectViewSwitcherPresentation: "dropdown",
      sidebarBackground: {
        kind: "none",
        overlayColor: "#1a1a1c",
        overlayOpacity: 100,
        vibrancyMode: "subtle",
      },
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "pinned" },
      firstRunOnboarding: "pending",
      // Navigator starts honestly unconfigured: no default model, no reviewer.
      navigatorAssistant: {},
      // The host has not been told who is using it, so the profile carries no
      // name and no address — only the accent the initials avatar falls back to.
      userProfile: { accent: "indigo", avatar: { kind: "initials" } },
    });
    expect(replaceShellSettings(current, replacement)).toEqual({
      ...replacement,
      sidebarWidth: 420,
      contextSidebarWidth: 640,
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "pinned" },
    });
    expect(current.chatEnabled).toBe(true);
    expect(replaceShellSettings(current, { ...replacement, sidebarWidth: 1 }).sidebarWidth).toBe(
      220,
    );
    expect(
      replaceShellSettings(current, { ...replacement, contextSidebarWidth: 1 }).contextSidebarWidth,
    ).toBe(280);
    expect(replaceShellSettings(current, replacement).lastContextSurface).toBe("code-environment");
    expect(replaceShellSettings(current, replacement).modeSwitcherPresentation).toBe("dropdown");
    expect(
      replaceShellSettings(current, { ...replacement, lastContextSurface: null })
        .lastContextSurface,
    ).toBeNull();
  });

  it("resolves first-run onboarding once and never reopens it", () => {
    const pending = defaultShellSettings();
    const completed: ShellSettings = { ...pending, firstRunOnboarding: "completed" };

    expect(
      replaceShellSettings(pending, { ...pending, firstRunOnboarding: "completed" })
        .firstRunOnboarding,
    ).toBe("completed");
    expect(
      replaceShellSettings(pending, { ...pending, firstRunOnboarding: "skipped" })
        .firstRunOnboarding,
    ).toBe("skipped");

    // A renderer that replays or forges a pending document must not make first
    // run reappear on the next launch, and skipping must not upgrade to
    // completed.
    expect(
      replaceShellSettings(completed, { ...completed, firstRunOnboarding: "pending" })
        .firstRunOnboarding,
    ).toBe("completed");
    expect(
      replaceShellSettings({ ...pending, firstRunOnboarding: "skipped" }, completed)
        .firstRunOnboarding,
    ).toBe("skipped");
    expect(resolveFirstRunOnboarding("pending", "pending")).toBe("pending");
  });
});

describe("workspace validation", () => {
  it("builds independent welcome layouts for every mode with Chat active", () => {
    const workspace = defaultWindowWorkspace(ids.window);

    expect(workspace.activeMode).toBe("chat");
    expect(workspace.activeGroupIds).toEqual({
      chat: onlyGroup(workspace.layouts.chat).groupId,
      work: onlyGroup(workspace.layouts.work).groupId,
      code: onlyGroup(workspace.layouts.code).groupId,
    });
    expect(workspace.focusedGroupId).toBeUndefined();
    expect(workspace.version).toBe(0);
    expect(
      Object.entries(workspace.layouts).map(([mode, layout]) => [mode, onlyGroup(layout).tabs[0]]),
    ).toEqual([
      ["chat", expect.objectContaining({ kind: "welcome", mode: "chat" })],
      ["work", expect.objectContaining({ kind: "welcome", mode: "work" })],
      ["code", expect.objectContaining({ kind: "welcome", mode: "code" })],
    ]);
    expect(() => validateWorkspace(workspace)).not.toThrow();
  });

  it("rejects invalid active membership, duplicate identities, unreachable focus, and limits", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const expectRejected = (workspace: WindowWorkspace) =>
      expect(() => validateWorkspace(workspace)).toThrow(ShellPolicyRejected);

    expectRejected({
      ...base,
      layouts: { ...base.layouts, code: { ...code, activeTabId: ids.tabA } },
    });
    expectRejected({ ...base, layouts: { ...base.layouts, work: base.layouts.chat } });
    expectRejected({ ...base, focusedGroupId: ids.groupA });
    expectRejected({ ...base, focusedGroupId: onlyGroup(base.layouts.code).groupId });
    expectRejected({
      ...base,
      activeGroupIds: { ...base.activeGroupIds, code: onlyGroup(base.layouts.chat).groupId },
    });

    let deep: WorkspaceLayoutNode = code;
    for (let depth = 1; depth <= MAX_LAYOUT_DEPTH; depth += 1) {
      deep = {
        kind: "split",
        nodeId: decodeLayoutNodeId(`10000000-0000-4000-8000-${String(depth).padStart(12, "0")}`),
        orientation: "horizontal",
        ratio: 0.5,
        first: deep,
        second: {
          ...code,
          nodeId: decodeLayoutNodeId(`20000000-0000-4000-8000-${String(depth).padStart(12, "0")}`),
          groupId: decodeTabGroupId(`30000000-0000-4000-8000-${String(depth).padStart(12, "0")}`),
          tabs: [
            tab(decodeWorkspaceTabId(`40000000-0000-4000-8000-${String(depth).padStart(12, "0")}`)),
          ],
          activeTabId: decodeWorkspaceTabId(
            `40000000-0000-4000-8000-${String(depth).padStart(12, "0")}`,
          ),
        },
      };
    }
    expectRejected({ ...base, layouts: { ...base.layouts, code: deep } });

    const tooManyGroups = Array.from({ length: MAX_TAB_GROUPS + 1 }, (_, index) => ({
      ...code,
      nodeId: decodeLayoutNodeId(`50000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      groupId: decodeTabGroupId(`60000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      tabs: [
        tab(decodeWorkspaceTabId(`70000000-0000-4000-8000-${String(index).padStart(12, "0")}`)),
      ],
      activeTabId: decodeWorkspaceTabId(
        `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    }));
    const join = (groups: ReadonlyArray<WorkspaceLayoutNode>): WorkspaceLayoutNode =>
      groups.length === 1
        ? groups[0]!
        : {
            kind: "split",
            nodeId: decodeLayoutNodeId(
              `80000000-0000-4000-8000-${String(groups.length).padStart(12, "0")}`,
            ),
            orientation: "vertical",
            ratio: 0.5,
            first: groups[0]!,
            second: join(groups.slice(1)),
          };
    expectRejected({ ...base, layouts: { ...base.layouts, code: join(tooManyGroups) } });

    const tabs = Array.from({ length: MAX_WORKSPACE_TABS + 1 }, (_, index) =>
      tab(decodeWorkspaceTabId(`90000000-0000-4000-8000-${String(index).padStart(12, "0")}`)),
    );
    expectRejected({
      ...base,
      layouts: { ...base.layouts, code: { ...code, tabs, activeTabId: tabs[0]!.id } },
    });

    const crossModeTabs = tabs.slice(0, MAX_WORKSPACE_TABS - 1);
    expectRejected({
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: crossModeTabs, activeTabId: crossModeTabs[0]!.id },
      },
    });
  });

  it("rejects welcome tabs whose mode differs from the enclosing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyGroup(base.layouts.chat);
    const mismatched = tab(ids.tabA);

    expect(() =>
      validateWorkspace({
        ...base,
        layouts: {
          ...base.layouts,
          chat: { ...chat, tabs: [mismatched], activeTabId: mismatched.id },
        },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("rejects Chat thread tabs outside Chat layouts and accepts them in Chat", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyGroup(base.layouts.chat);
    const code = onlyGroup(base.layouts.code);
    const chatThreadTab = decodeWorkspaceTab({
      kind: "chat-thread",
      id: ids.tabA,
      threadId: ids.thread,
      mode: "chat",
      title: "Planning",
    });

    expect(
      validateWorkspace({
        ...base,
        layouts: {
          ...base.layouts,
          chat: { ...chat, tabs: [chatThreadTab], activeTabId: chatThreadTab.id },
        },
      }),
    ).toMatchObject({
      layouts: { chat: { tabs: [chatThreadTab] } },
    });
    expect(() =>
      validateWorkspace({
        ...base,
        layouts: {
          ...base.layouts,
          code: { ...code, tabs: [chatThreadTab], activeTabId: chatThreadTab.id },
        },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("rejects Project tabs whose mode differs from the enclosing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyGroup(base.layouts.chat);
    const mismatched = decodeWorkspaceTab({
      kind: "project",
      id: ids.tabA,
      projectId: ids.project,
      mode: "code",
      title: "Code Project",
    });

    expect(() =>
      validateWorkspace({
        ...base,
        layouts: {
          ...base.layouts,
          chat: { ...chat, tabs: [mismatched], activeTabId: mismatched.id },
        },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("accepts a layout exactly at depth 6", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeLayoutWithGroups(MAX_LAYOUT_DEPTH);
    const workspace = {
      ...base,
      layouts: { ...base.layouts, code },
      activeGroupIds: { ...base.activeGroupIds, code: firstGroupId(code) },
    };

    expect(validateWorkspace(workspace)).toBe(workspace);
  });

  it("accepts exactly 8 groups across the workspace", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeLayoutWithGroups(MAX_TAB_GROUPS - 2);
    const workspace = {
      ...base,
      layouts: { ...base.layouts, code },
      activeGroupIds: { ...base.activeGroupIds, code: firstGroupId(code) },
    };

    expect(validateWorkspace(workspace)).toBe(workspace);
  });

  it("accepts exactly 48 tabs across the workspace", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const tabs = Array.from({ length: MAX_WORKSPACE_TABS - 2 }, (_, index) =>
      tab(decodeWorkspaceTabId(`b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`)),
    );
    const workspace = {
      ...base,
      layouts: { ...base.layouts, code: { ...code, tabs, activeTabId: tabs[0]!.id } },
    };

    expect(validateWorkspace(workspace)).toBe(workspace);
  });
});

describe("workspace settings reconciliation", () => {
  it.each(["chat", "work"] as const)(
    "falls back from disabled %s to Code without deleting layout state and clears focus",
    (mode) => {
      const base = defaultWindowWorkspace(ids.window);
      const workspace = {
        ...base,
        activeMode: mode,
        focusedGroupId: onlyGroup(base.layouts[mode]).groupId,
      };
      const settings = {
        ...defaultShellSettings(),
        chatEnabled: mode !== "chat",
        workEnabled: mode !== "work",
      };

      const reconciled = reconcileWorkspaceWithSettings(workspace, settings);

      const { focusedGroupId: _focusedGroupId, ...unfocused } = workspace;
      expect(reconciled).toEqual({ ...unfocused, activeMode: "code" });
      expect(reconciled.layouts).toBe(workspace.layouts);
      expect(reconciled.focusedGroupId).toBeUndefined();
      expect(() => validateWorkspace(reconciled)).not.toThrow();
    },
  );

  it("returns the original workspace when the active mode is enabled or already Code", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = {
      ...base,
      activeMode: "chat" as const,
      focusedGroupId: onlyGroup(base.layouts.chat).groupId,
    };

    expect(reconcileWorkspaceWithSettings(chat, defaultShellSettings())).toBe(chat);
    const code = { ...base, activeMode: "code" as const };
    expect(
      reconcileWorkspaceWithSettings(code, {
        ...defaultShellSettings(),
        chatEnabled: false,
        workEnabled: false,
      }),
    ).toBe(code);
  });
});

describe("workspace operations", () => {
  it("rejects opening a welcome tab into a different mode layout", () => {
    const base = defaultWindowWorkspace(ids.window);

    expect(() =>
      applyWorkspaceOperation(base, {
        kind: "open-tab",
        mode: "chat",
        groupId: onlyGroup(base.layouts.chat).groupId,
        tab: tab(ids.tabA),
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("opens, recovers, activates, reorders, and closes tabs immutably", () => {
    const base = defaultWindowWorkspace(ids.window);
    const groupId = codeGroup(base).groupId;
    const opened = applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({ kind: "open-tab", mode: "code", groupId, tab: tab(ids.tabA) }),
    );
    const unavailable = applyWorkspaceOperation(
      opened,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "code",
        groupId,
        tab: tab(ids.tabB, "unavailable"),
      }),
    );
    const recovered = applyWorkspaceOperation(
      unavailable,
      decodeWorkspaceOperation({ kind: "open-tab", mode: "code", groupId, tab: tab(ids.tabB) }),
    );
    const activated = applyWorkspaceOperation(
      recovered,
      decodeWorkspaceOperation({ kind: "activate-tab", mode: "code", groupId, tabId: ids.tabA }),
    );
    const reordered = applyWorkspaceOperation(
      activated,
      decodeWorkspaceOperation({
        kind: "reorder-tab",
        mode: "code",
        groupId,
        tabId: ids.tabA,
        index: 0,
      }),
    );
    const closed = applyWorkspaceOperation(
      reordered,
      decodeWorkspaceOperation({ kind: "close-tab", mode: "code", groupId, tabId: ids.tabA }),
    );

    expect(codeGroup(base).tabs).toHaveLength(1);
    expect(codeGroup(recovered).tabs.find((item) => item.id === ids.tabB)?.kind).toBe("welcome");
    expect(codeGroup(activated).activeTabId).toBe(ids.tabA);
    expect(codeGroup(reordered).tabs[0]?.id).toBe(ids.tabA);
    expect(codeGroup(closed).tabs.some((item) => item.id === ids.tabA)).toBe(false);
    expect(closed.version).toBe(base.version + 6);
  });

  it("recovers a sole unavailable placeholder in place", () => {
    const base = defaultWindowWorkspace(ids.window);
    const group = codeGroup(base);
    const unavailable = tab(ids.tabA, "unavailable");
    const workspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...group, tabs: [unavailable], activeTabId: unavailable.id },
      },
    };

    const recovered = applyWorkspaceOperation(workspace, {
      kind: "open-tab",
      mode: "code",
      groupId: group.groupId,
      tab: tab(ids.tabA),
    });

    expect(codeGroup(recovered)).toMatchObject({
      groupId: group.groupId,
      tabs: [{ kind: "welcome", id: ids.tabA }],
      activeTabId: ids.tabA,
    });
  });

  it("splits, resizes, moves tabs, and collapses empty split branches", () => {
    const base = defaultWindowWorkspace(ids.window);
    const groupA = codeGroup(base).groupId;
    const withTab = applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "code",
        groupId: groupA,
        tab: tab(ids.tabA),
      }),
    );
    const split = applyWorkspaceOperation(
      withTab,
      decodeWorkspaceOperation({
        kind: "split-group",
        mode: "code",
        groupId: groupA,
        tabId: ids.tabA,
        splitNodeId: ids.splitA,
        newGroupNodeId: ids.nodeB,
        newGroupId: ids.groupB,
        orientation: "horizontal",
        placement: "before",
        ratio: 0.7,
      }),
    );
    expect(split.layouts.code).toMatchObject({
      kind: "split",
      nodeId: ids.splitA,
      ratio: 0.7,
      first: { kind: "group", groupId: ids.groupB },
      second: { kind: "group", groupId: groupA },
    });
    expect(split.activeGroupIds.code).toBe(ids.groupB);

    const resized = applyWorkspaceOperation(split, {
      kind: "resize-split",
      mode: "code",
      splitNodeId: ids.splitA,
      ratio: 9,
    });
    expect(resized.layouts.code).toMatchObject({ ratio: 0.8 });

    const collapsed = applyWorkspaceOperation(
      resized,
      decodeWorkspaceOperation({
        kind: "move-tab",
        mode: "code",
        fromGroupId: groupA,
        toGroupId: ids.groupB,
        tabId: codeGroup(base).tabs[0]!.id,
        index: 1,
      }),
    );
    expect(collapsed.layouts.code).toMatchObject({ kind: "group", groupId: ids.groupB });
    expect(collapsed.activeGroupIds.code).toBe(ids.groupB);
    expect(onlyGroup(collapsed.layouts.code).tabs).toHaveLength(2);
  });

  it.each([
    ["horizontal", "before"],
    ["horizontal", "after"],
    ["vertical", "before"],
    ["vertical", "after"],
  ] as const)("atomically docks a tab %s %s another group", (orientation, placement) => {
    const base = defaultWindowWorkspace(ids.window);
    const sourceGroupId = codeGroup(base).groupId;
    const withTab = applyWorkspaceOperation(base, {
      kind: "open-tab",
      mode: "code",
      groupId: sourceGroupId,
      tab: tab(ids.tabA),
    });
    const split = applyWorkspaceOperation(withTab, {
      kind: "split-group",
      mode: "code",
      groupId: sourceGroupId,
      tabId: ids.tabA,
      splitNodeId: ids.splitA,
      newGroupNodeId: ids.nodeB,
      newGroupId: ids.groupB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });

    const docked = applyWorkspaceOperation(split, {
      kind: "dock-tab",
      mode: "code",
      fromGroupId: ids.groupB,
      targetGroupId: sourceGroupId,
      tabId: ids.tabA,
      splitNodeId: ids.splitB,
      newGroupNodeId: ids.nodeC,
      newGroupId: ids.groupC,
      orientation,
      placement,
      ratio: 0.5,
    });

    expect(docked.version).toBe(split.version + 1);
    expect(docked.activeGroupIds.code).toBe(ids.groupC);
    expect(docked.layouts.code).toMatchObject({
      kind: "split",
      nodeId: ids.splitB,
      orientation,
      [placement === "before" ? "first" : "second"]: {
        kind: "group",
        groupId: ids.groupC,
        tabs: [{ id: ids.tabA }],
      },
      [placement === "before" ? "second" : "first"]: {
        kind: "group",
        groupId: sourceGroupId,
      },
    });
  });

  it("rejects stale or colliding atomic docks without mutating the source workspace", () => {
    const base = defaultWindowWorkspace(ids.window);
    const sourceGroupId = codeGroup(base).groupId;
    const withTab = applyWorkspaceOperation(base, {
      kind: "open-tab",
      mode: "code",
      groupId: sourceGroupId,
      tab: tab(ids.tabA),
    });
    const split = applyWorkspaceOperation(withTab, {
      kind: "split-group",
      mode: "code",
      groupId: sourceGroupId,
      tabId: ids.tabA,
      splitNodeId: ids.splitA,
      newGroupNodeId: ids.nodeB,
      newGroupId: ids.groupB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });
    const valid = {
      kind: "dock-tab" as const,
      mode: "code" as const,
      fromGroupId: ids.groupB,
      targetGroupId: sourceGroupId,
      tabId: ids.tabA,
      splitNodeId: ids.splitB,
      newGroupNodeId: ids.nodeC,
      newGroupId: ids.groupC,
      orientation: "vertical" as const,
      placement: "before" as const,
      ratio: 0.5 as const,
    };

    for (const operation of [
      { ...valid, fromGroupId: ids.groupC },
      { ...valid, targetGroupId: ids.groupC },
      { ...valid, targetGroupId: ids.groupB },
      { ...valid, splitNodeId: ids.splitA },
      { ...valid, newGroupNodeId: codeGroup(base).nodeId },
      { ...valid, newGroupId: sourceGroupId },
    ]) {
      expect(() => applyWorkspaceOperation(split, operation)).toThrow(ShellPolicyRejected);
      expect(split.layouts.code).toMatchObject({ kind: "split", nodeId: ids.splitA });
    }
  });

  it("focuses only reachable active-mode groups, unfocuses, resets, and switches modes", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const codeGroupId = codeGroup(base).groupId;
    const focused = applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({ kind: "focus-group", mode: "code", groupId: codeGroupId }),
    );
    expect(focused.focusedGroupId).toBe(codeGroupId);
    expect(focused.activeGroupIds.code).toBe(codeGroupId);

    expect(() =>
      applyWorkspaceOperation(
        focused,
        decodeWorkspaceOperation({
          kind: "focus-group",
          mode: "chat",
          groupId: onlyGroup(base.layouts.chat).groupId,
        }),
      ),
    ).toThrow(ShellPolicyRejected);

    const unfocused = applyWorkspaceOperation(
      focused,
      decodeWorkspaceOperation({ kind: "unfocus-group", mode: "code" }),
    );
    expect(unfocused.focusedGroupId).toBeUndefined();

    const switched = applyWorkspaceOperation(
      focused,
      decodeWorkspaceOperation({ kind: "set-active-mode", mode: "chat" }),
    );
    expect(switched.activeMode).toBe("chat");
    expect(switched.focusedGroupId).toBeUndefined();

    const changedChat = applyWorkspaceOperation(
      switched,
      decodeWorkspaceOperation({
        kind: "open-tab",
        mode: "chat",
        groupId: onlyGroup(switched.layouts.chat).groupId,
        tab: { kind: "settings", id: ids.tabC, title: "Settings" },
      }),
    );
    const reset = applyWorkspaceOperation(
      changedChat,
      decodeWorkspaceOperation({ kind: "reset-mode", mode: "chat" }),
    );
    expect(onlyGroup(reset.layouts.chat).tabs).toHaveLength(1);
    expect(onlyGroup(reset.layouts.chat).tabs[0]).toMatchObject({ kind: "welcome", mode: "chat" });
    expect(reset.layouts.code).toBe(changedChat.layouts.code);
  });

  it("rejects malformed references, duplicate IDs, invalid indexes, and redundant splits", () => {
    const base = defaultWindowWorkspace(ids.window);
    const groupId = codeGroup(base).groupId;
    const missingGroup = ids.groupA;
    const existingTab = codeGroup(base).tabs[0]!;
    const reject = (operation: Parameters<typeof applyWorkspaceOperation>[1]) =>
      expect(() => applyWorkspaceOperation(base, operation)).toThrow(ShellPolicyRejected);

    reject({ kind: "activate-tab", mode: "code", groupId: missingGroup, tabId: existingTab.id });
    reject({ kind: "open-tab", mode: "code", groupId, tab: existingTab });
    reject({ kind: "reorder-tab", mode: "code", groupId, tabId: existingTab.id, index: 2 });
    reject({
      kind: "split-group",
      mode: "code",
      groupId,
      tabId: existingTab.id,
      splitNodeId: ids.splitA,
      newGroupNodeId: ids.nodeB,
      newGroupId: ids.groupB,
      orientation: "vertical",
      placement: "after",
      ratio: 0.5,
    });
  });
});

describe("workspace context validation", () => {
  it("rejects Browser and Files tabs when the mode context has no bound root", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const browserTab = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    expect(() =>
      validateWorkspace({
        ...base,
        layouts: {
          ...base.layouts,
          code: { ...code, tabs: [browserTab], activeTabId: browserTab.id },
        },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("accepts Browser and Files tabs when the mode context binds a root", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const browserTab = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    const bound: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: {
          host: base.contextByMode.code.host,
          mode: "code",
          projectId: ids.project,
          boundRoot: "/home/repo",
        },
      },
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: [browserTab], activeTabId: browserTab.id },
      },
    };
    expect(validateWorkspace(bound)).toBeDefined();
  });

  it("accepts a Project tab whose Project differs from the mode context (authority enforced at server boundary)", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const projectTab = decodeWorkspaceTab({
      kind: "project",
      id: ids.tabA,
      projectId: ids.project,
      mode: "code",
      title: "Project",
    });
    const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000502");
    // validateWorkspace is structural; cross-Project authority is enforced by
    // resolveWorkspaceContext at the server boundary so cross-context opens can
    // surface the cross-context failure with an Open-in-new-window offer.
    expect(() =>
      validateWorkspace({
        ...base,
        contextByMode: {
          chat: base.contextByMode.chat,
          work: base.contextByMode.work,
          code: {
            host: base.contextByMode.code.host,
            mode: "code",
            projectId: otherProject,
            boundRoot: "/home/other",
          },
        },
        layouts: {
          ...base.layouts,
          code: { ...code, tabs: [projectTab], activeTabId: projectTab.id },
        },
      } satisfies WindowWorkspace),
    ).not.toThrow();
  });
});

describe("workspace surface descriptors", () => {
  it("exposes Thread and Side Chat in every mode without a bound root", () => {
    const chat = resolveSurfaceDescriptors({
      host: baseHost(),
      mode: "chat",
      projectId: null,
      boundRoot: null,
    });
    expect(chat.map((d) => d.kind)).toContain("thread");
    expect(chat.map((d) => d.kind)).toContain("side-chat");
    expect(chat.find((d) => d.kind === "browser")?.available).toBe(false);
    expect(chat.find((d) => d.kind === "files")?.available).toBe(false);
    expect(chat.some((d) => d.kind === "terminal")).toBe(false);
  });

  it("enables Browser and Files once a root is bound; Terminal/Diff/Git-Review are thread-scoped, not launcher surfaces", () => {
    const code = resolveSurfaceDescriptors({
      host: baseHost(),
      mode: "code",
      projectId: ids.project,
      boundRoot: "/home/repo",
    });
    expect(code.find((d) => d.kind === "browser")?.available).toBe(true);
    expect(code.find((d) => d.kind === "files")?.available).toBe(true);
    // terminal, diff, and git-review require an active Code thread context and
    // are opened within a Code thread via code surface controls, not the
    // New Tab launcher, so they are not advertised in the surface catalog.
    expect(code.some((d) => d.kind === "terminal")).toBe(false);
    expect(code.some((d) => d.kind === "diff")).toBe(false);
    expect(code.some((d) => d.kind === "git-review")).toBe(false);
  });

  it("never exposes Terminal, Diff, or Git/Review in any mode catalog", () => {
    const work = resolveSurfaceDescriptors({
      host: baseHost(),
      mode: "work",
      projectId: ids.project,
      boundRoot: "/home/folder",
    });
    expect(work.some((d) => d.kind === "terminal")).toBe(false);
    expect(work.some((d) => d.kind === "diff")).toBe(false);
    expect(work.some((d) => d.kind === "git-review")).toBe(false);
    const code = resolveSurfaceDescriptors({
      host: baseHost(),
      mode: "code",
      projectId: ids.project,
      boundRoot: "/home/repo",
    });
    expect(code.some((d) => d.kind === "terminal")).toBe(false);
    expect(code.some((d) => d.kind === "diff")).toBe(false);
    expect(code.some((d) => d.kind === "git-review")).toBe(false);
  });
});

describe("workspace context resolution", () => {
  const host = baseHost();
  const projectTab = decodeWorkspaceTab({
    kind: "project",
    id: ids.tabA,
    projectId: ids.project,
    mode: "code",
    title: "Project",
  });
  const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000502");

  it("anchors an unfiled context to the opened Project tab", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const resolved = resolveWorkspaceContext(
      {
        ...base,
        layouts: {
          ...base.layouts,
          code: { ...code, tabs: [projectTab], activeTabId: projectTab.id },
        },
      },
      { kind: "open-tab", mode: "code", groupId: code.groupId, tab: projectTab },
      {
        tabContext: (tab) =>
          tab.kind === "project"
            ? { host, mode: "code", projectId: tab.projectId, boundRoot: "/home/repo" }
            : undefined,
      },
    );
    expect(resolved.contextByMode.code.projectId).toBe(ids.project);
    expect(resolved.contextByMode.code.boundRoot).toBe("/home/repo");
  });

  it("rejects opening a Project tab into a context bound to a different Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" },
      },
    };
    expect(() =>
      resolveWorkspaceContext(
        anchored,
        { kind: "open-tab", mode: "code", groupId: codeGroup(base).groupId, tab: projectTab },
        {
          tabContext: (tab) =>
            tab.kind === "project"
              ? { host, mode: "code", projectId: tab.projectId, boundRoot: "/home/repo" }
              : undefined,
        },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("switches the mode context and replaces its layout for an explicit Project switch", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        ...base.contextByMode,
        code: { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" },
      },
    };
    const operation = decodeWorkspaceOperation({
      kind: "switch-project-tab",
      mode: "code",
      tab: projectTab,
    });
    const resolved = resolveWorkspaceContext(anchored, operation, {
      tabContext: (candidate) =>
        candidate.kind === "project"
          ? { host, mode: "code", projectId: candidate.projectId, boundRoot: "/home/repo" }
          : undefined,
    });
    const switched = applyWorkspaceOperation(resolved, operation);

    expect(switched.contextByMode.code).toEqual({
      host,
      mode: "code",
      projectId: ids.project,
      boundRoot: "/home/repo",
    });
    expect(codeGroup(switched).tabs).toEqual([projectTab]);
    expect(codeGroup(switched).activeTabId).toBe(projectTab.id);
  });

  it("stows the outgoing Project layout and restores it when switching back", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const threadTabA1 = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabB,
      threadId: ids.codeThread,
      mode: "code",
      title: "A first",
    });
    const threadTabA2 = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabC,
      threadId: ids.codeThread,
      mode: "code",
      title: "A second",
    });
    const splitLayout: WorkspaceLayoutNode = {
      kind: "split",
      nodeId: ids.splitA,
      orientation: "horizontal",
      ratio: 0.5,
      first: {
        ...code,
        nodeId: ids.nodeA,
        groupId: ids.groupA,
        tabs: [threadTabA1],
        activeTabId: threadTabA1.id,
      },
      second: {
        ...code,
        nodeId: ids.nodeB,
        groupId: ids.groupB,
        tabs: [threadTabA2],
        activeTabId: threadTabA2.id,
      },
    };
    const anchored: WindowWorkspace = {
      ...base,
      layouts: { ...base.layouts, code: splitLayout },
      activeGroupIds: { ...base.activeGroupIds, code: ids.groupB },
      contextByMode: {
        ...base.contextByMode,
        code: { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" },
      },
    };
    const switchToB = decodeWorkspaceOperation({
      kind: "switch-project-tab",
      mode: "code",
      tab: projectTab,
    });
    const resolverB = {
      tabContext: (candidate: typeof projectTab) =>
        candidate.kind === "project"
          ? { host, mode: "code" as const, projectId: candidate.projectId, boundRoot: "/home/repo" }
          : undefined,
    };
    const inB = applyWorkspaceOperation(
      resolveWorkspaceContext(anchored, switchToB, resolverB),
      switchToB,
    );
    expect(codeGroup(inB).tabs).toEqual([projectTab]);
    expect(inB.stowedLayouts).toHaveLength(1);
    expect(inB.stowedLayouts[0]?.context.projectId).toBe(otherProject);
    expect(inB.stowedLayouts[0]?.layout).toEqual(splitLayout);
    expect(inB.stowedLayouts[0]?.activeGroupId).toBe(ids.groupB);

    const returnTab = decodeWorkspaceTab({
      kind: "project",
      id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000104"),
      projectId: otherProject,
      mode: "code",
      title: "Project A",
    });
    const switchToA = decodeWorkspaceOperation({
      kind: "switch-project-tab",
      mode: "code",
      tab: returnTab,
    });
    const resolverA = {
      tabContext: (candidate: typeof returnTab) =>
        candidate.kind === "project"
          ? {
              host,
              mode: "code" as const,
              projectId: candidate.projectId,
              boundRoot: "/home/other",
            }
          : undefined,
    };
    const backInA = applyWorkspaceOperation(
      resolveWorkspaceContext(inB, switchToA, resolverA),
      switchToA,
    );

    expect(backInA.contextByMode.code).toEqual({
      host,
      mode: "code",
      projectId: otherProject,
      boundRoot: "/home/other",
    });
    expect(backInA.layouts.code).toMatchObject({ kind: "split" });
    const restoredFirst = onlyGroup(
      backInA.layouts.code.kind === "split" ? backInA.layouts.code.first : backInA.layouts.code,
    );
    expect(restoredFirst.tabs).toEqual([threadTabA1]);
    const restoredSecond = onlyGroup(
      backInA.layouts.code.kind === "split" ? backInA.layouts.code.second : backInA.layouts.code,
    );
    expect(restoredSecond.tabs).toEqual([threadTabA2, returnTab]);
    expect(restoredSecond.activeTabId).toBe(returnTab.id);
    expect(backInA.activeGroupIds.code).toBe(ids.groupB);
    expect(backInA.stowedLayouts).toHaveLength(1);
    expect(backInA.stowedLayouts[0]?.context.projectId).toBe(ids.project);
  });

  it("does not stow a welcome-only outgoing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const operation = decodeWorkspaceOperation({
      kind: "switch-project-tab",
      mode: "code",
      tab: projectTab,
    });
    const switched = applyWorkspaceOperation(
      resolveWorkspaceContext(base, operation, {
        tabContext: (candidate) =>
          candidate.kind === "project"
            ? {
                host,
                mode: "code" as const,
                projectId: candidate.projectId,
                boundRoot: "/home/repo",
              }
            : undefined,
      }),
      operation,
    );
    expect(switched.stowedLayouts).toEqual([]);
    expect(codeGroup(switched).tabs).toEqual([projectTab]);
  });

  it("rejects stowed layouts beyond the bounded count or with duplicate contexts", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const entry = (index: number) => ({
      context: {
        host,
        mode: "code" as const,
        projectId: decodeProjectId(`b1000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        boundRoot: `/home/repo-${index}`,
      },
      layout: {
        ...code,
        tabs: [tab(ids.tabA)],
        activeTabId: ids.tabA,
      },
      activeGroupId: code.groupId,
    });
    const within = { ...base, stowedLayouts: Array.from({ length: 12 }, (_, i) => entry(i)) };
    expect(() => validateWorkspace(within)).not.toThrow();
    const beyond = { ...base, stowedLayouts: Array.from({ length: 13 }, (_, i) => entry(i)) };
    expect(() => validateWorkspace(beyond)).toThrow(ShellPolicyRejected);
    const duplicate = { ...base, stowedLayouts: [entry(1), entry(1)] };
    expect(() => validateWorkspace(duplicate)).toThrow(ShellPolicyRejected);
  });

  it("rejects activating a restored thread tab from a different Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeGroup(base);
    const threadTab = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabA,
      threadId: ids.codeThread,
      mode: "code",
      title: "Other Project thread",
    });
    const anchored: WindowWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        code: { ...code, tabs: [threadTab], activeTabId: threadTab.id },
      },
      contextByMode: {
        ...base.contextByMode,
        code: { host, mode: "code", projectId: ids.project, boundRoot: "/home/repo" },
      },
    };

    expect(() =>
      resolveWorkspaceContext(
        anchored,
        {
          kind: "activate-tab",
          mode: "code",
          groupId: code.groupId,
          tabId: threadTab.id,
        },
        {
          tabContext: (tab) =>
            tab.kind === "code-overview"
              ? { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" }
              : undefined,
        },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rejects Browser and Files surfaces when no root is bound", () => {
    const base = defaultWindowWorkspace(ids.window);
    const browserTab = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    expect(() =>
      resolveWorkspaceContext(
        base,
        { kind: "open-tab", mode: "code", groupId: codeGroup(base).groupId, tab: browserTab },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rejects a cross-host surface with a new-window offer", () => {
    const base = defaultWindowWorkspace(ids.window);
    const remoteHost = "remote-host";
    const chatThreadTab = decodeWorkspaceTab({
      kind: "chat-thread",
      id: ids.tabA,
      threadId: ids.thread,
      mode: "chat",
      title: "Thread",
    });
    expect(() =>
      resolveWorkspaceContext(
        base,
        {
          kind: "open-tab",
          mode: "chat",
          groupId: onlyGroup(base.layouts.chat).groupId,
          tab: chatThreadTab,
        },
        {
          tabContext: () => ({
            host: remoteHost as never,
            mode: "chat",
            projectId: null,
            boundRoot: null,
          }),
        },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rebinds the context when the same Project relinks to a new canonical root", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: { host, mode: "code", projectId: ids.project, boundRoot: "/home/old-root" },
      },
    };
    const resolved = resolveWorkspaceContext(
      anchored,
      { kind: "open-tab", mode: "code", groupId: codeGroup(base).groupId, tab: projectTab },
      {
        tabContext: (tab) =>
          tab.kind === "project"
            ? { host, mode: "code", projectId: tab.projectId, boundRoot: "/home/new-root" }
            : undefined,
      },
    );
    expect(resolved.contextByMode.code.boundRoot).toBe("/home/new-root");
    expect(resolved.contextByMode.code.projectId).toBe(ids.project);
  });

  it("rejects a thread tab whose Project context cannot be resolved", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chatThreadTab = decodeWorkspaceTab({
      kind: "chat-thread",
      id: ids.tabA,
      threadId: ids.thread,
      mode: "chat",
      title: "Thread",
    });
    expect(() =>
      resolveWorkspaceContext(
        base,
        {
          kind: "open-tab",
          mode: "chat",
          groupId: onlyGroup(base.layouts.chat).groupId,
          tab: chatThreadTab,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it.each(["code", "work"] as const)(
    "allows a local source-qualified rootless %s thread to remain unbound",
    (mode) => {
      const base = defaultWindowWorkspace(ids.window);
      const layout = onlyGroup(base.layouts[mode]);
      const rootlessTab = decodeWorkspaceTab(
        mode === "code"
          ? {
              kind: "code-overview",
              id: ids.tabA,
              threadId: ids.codeThread,
              mode,
              title: "Rootless Code",
              hostId: base.contextByMode.code.host,
            }
          : {
              kind: "work-thread",
              id: ids.tabA,
              threadId: decodeWorkThreadId("00000000-0000-4000-8000-000000000603"),
              mode,
              title: "Rootless Work",
              hostId: base.contextByMode.work.host,
            },
      );
      const resolved = resolveWorkspaceContext(
        base,
        { kind: "open-tab", mode, groupId: layout.groupId, tab: rootlessTab },
        { tabContext: () => undefined },
      );

      expect(resolved.contextByMode[mode].projectId).toBeNull();
      expect(resolved.contextByMode[mode].boundRoot).toBeNull();
    },
  );

  it.each(["code", "work"] as const)(
    "rejects a source-qualified rootless %s thread in a Project-bound context",
    (mode) => {
      const base = defaultWindowWorkspace(ids.window);
      const layout = onlyGroup(base.layouts[mode]);
      const rootlessTab = decodeWorkspaceTab(
        mode === "code"
          ? {
              kind: "code-overview",
              id: ids.tabA,
              threadId: ids.codeThread,
              mode,
              title: "Rootless Code",
              hostId: base.contextByMode.code.host,
            }
          : {
              kind: "work-thread",
              id: ids.tabA,
              threadId: decodeWorkThreadId("00000000-0000-4000-8000-000000000603"),
              mode,
              title: "Rootless Work",
              hostId: base.contextByMode.work.host,
            },
      );
      const bound: WindowWorkspace = {
        ...base,
        contextByMode: {
          ...base.contextByMode,
          [mode]: {
            ...base.contextByMode[mode],
            projectId: ids.project,
            boundRoot: mode === "code" ? "/home/repo" : "/home/folder",
          },
        },
      };

      expect(() =>
        resolveWorkspaceContext(
          bound,
          { kind: "open-tab", mode, groupId: layout.groupId, tab: rootlessTab },
          { tabContext: () => undefined },
        ),
      ).toThrow(WorkspaceContextRejected);
      expect(bound.contextByMode[mode].projectId).toBe(ids.project);
      expect(bound.contextByMode[mode].boundRoot).not.toBeNull();
    },
  );

  it("rejects a source-qualified rootless Work thread from another host", () => {
    const base = defaultWindowWorkspace(ids.window);
    const layout = onlyGroup(base.layouts.work);
    const rootlessTab = decodeWorkspaceTab({
      kind: "work-thread",
      id: ids.tabA,
      threadId: decodeWorkThreadId("00000000-0000-4000-8000-000000000603"),
      mode: "work",
      title: "Remote rootless Work",
      hostId: "host-b",
    });

    expect(() =>
      resolveWorkspaceContext(
        base,
        { kind: "open-tab", mode: "work", groupId: layout.groupId, tab: rootlessTab },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("anchors an unbound context to the opened preview tab's Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewTab = decodeWorkspaceTab({
      kind: "preview",
      id: ids.tabA,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    });
    const resolved = resolveWorkspaceContext(
      base,
      {
        kind: "open-tab",
        mode: "work",
        groupId: onlyGroup(base.layouts.work).groupId,
        tab: previewTab,
      },
      { tabContext: () => undefined },
    );
    expect(resolved.contextByMode.work.projectId).toBe(ids.project);
  });

  it("allows a same-Project preview tab to coexist with the bound context", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: {
          host: base.contextByMode.work.host,
          mode: "work",
          projectId: ids.project,
          boundRoot: "/home/folder",
        },
        code: base.contextByMode.code,
      },
    };
    const previewTab = decodeWorkspaceTab({
      kind: "preview",
      id: ids.tabA,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    });
    const resolved = resolveWorkspaceContext(
      anchored,
      {
        kind: "open-tab",
        mode: "work",
        groupId: onlyGroup(base.layouts.work).groupId,
        tab: previewTab,
      },
      { tabContext: () => undefined },
    );
    expect(resolved.contextByMode.work.projectId).toBe(ids.project);
  });

  it("rejects a cross-Project preview tab before layout mutation", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: {
          host: base.contextByMode.work.host,
          mode: "work",
          projectId: otherProject,
          boundRoot: "/home/other",
        },
        code: base.contextByMode.code,
      },
    };
    const previewTab = decodeWorkspaceTab({
      kind: "preview",
      id: ids.tabA,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    });
    expect(() =>
      resolveWorkspaceContext(
        anchored,
        {
          kind: "open-tab",
          mode: "work",
          groupId: onlyGroup(base.layouts.work).groupId,
          tab: previewTab,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rejects a preview tab whose mode does not match the operation mode", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewTab = decodeWorkspaceTab({
      kind: "preview",
      id: ids.tabA,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    });
    expect(() =>
      resolveWorkspaceContext(
        base,
        {
          kind: "open-tab",
          mode: "code",
          groupId: onlyGroup(base.layouts.code).groupId,
          tab: previewTab,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("validateWorkspace rejects a preview tab in a context with no bound Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewTab = decodeWorkspaceTab({
      kind: "preview",
      id: ids.tabA,
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: ids.project,
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    });
    const withPreview: WindowWorkspace = {
      ...base,
      layouts: {
        ...base.layouts,
        work: {
          ...onlyGroup(base.layouts.work),
          tabs: [previewTab],
          activeTabId: previewTab.id,
        },
      },
    };
    expect(() => validateWorkspace(withPreview)).toThrow(ShellPolicyRejected);
  });
});

function baseHost() {
  return defaultWindowWorkspace(ids.window).contextByMode.chat.host;
}

describe("environment presentation policy", () => {
  it("defaults to hidden chat, floating work, and pinned code", () => {
    const state = defaultEnvironmentPresentationState();
    expect(state.byMode).toEqual({ chat: "hidden", work: "floating", code: "pinned" });
    expect(state.byTab).toEqual([]);
  });

  it("resolves the per-mode default when no tab override exists", () => {
    const state = defaultEnvironmentPresentationState();
    expect(resolveEffectivePresentation(state, "code", ids.tabA)).toBe("pinned");
    expect(resolveEffectivePresentation(state, "chat", ids.tabA)).toBe("hidden");
    expect(resolveEffectivePresentation(state, "work", ids.tabA)).toBe("floating");
  });

  it("resolves a tab override over the mode default", () => {
    const state = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "floating",
    });
    expect(resolveEffectivePresentation(state, "code", ids.tabA)).toBe("floating");
  });

  it("replaces an existing tab override instead of duplicating", () => {
    const base = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "floating",
    });
    const updated = replaceEnvironmentPresentation(base, {
      tabId: ids.tabA,
      presentation: "hidden",
    });
    expect(updated.byTab).toHaveLength(1);
    expect(resolveEffectivePresentation(updated, "code", ids.tabA)).toBe("hidden");
  });

  it("clamps pinned width to the supported range", () => {
    const tooSmall = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "pinned",
      pinnedWidth: 100,
    });
    expect(resolveEnvironmentPinnedWidth(tooSmall, ids.tabA)).toBe(240);
    const tooLarge = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "pinned",
      pinnedWidth: 999,
    });
    expect(resolveEnvironmentPinnedWidth(tooLarge, ids.tabA)).toBe(640);
  });

  it("removes a tab override so the mode default applies again", () => {
    const withOverride = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "floating",
    });
    const removed = removeEnvironmentPresentation(withOverride, ids.tabA);
    expect(resolveEffectivePresentation(removed, "code", ids.tabA)).toBe("pinned");
  });

  it("normalizes a full presentation state by clamping widths and deduplicating tabs", () => {
    const normalized = normalizeEnvironmentPresentationState({
      byTab: [
        { tabId: ids.tabA, presentation: "pinned", pinnedWidth: 100 },
        { tabId: ids.tabA, presentation: "hidden", pinnedWidth: 999 },
        { tabId: ids.tabB, presentation: "pinned", pinnedWidth: 999 },
      ],
      byMode: { chat: "hidden", work: "floating", code: "pinned" },
    });
    expect(normalized.byTab).toEqual([
      { tabId: ids.tabA, presentation: "pinned", pinnedWidth: 240 },
      { tabId: ids.tabB, presentation: "pinned", pinnedWidth: 640 },
    ]);
    expect(normalized.byMode).toEqual({ chat: "hidden", work: "floating", code: "pinned" });
  });

  it("includes environment presentation defaults in default shell settings", () => {
    expect(defaultShellSettings().environmentPresentationByMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "pinned",
    });
  });
});

describe("environment capability sections", () => {
  it("exposes only virtual context sections for chat", () => {
    const sections = filterEnvironmentSections("chat", { hasBoundRoot: false });
    const sectionIds = sections.map((s) => s.id);
    expect(sectionIds).toContain("project-context");
    expect(sectionIds).toContain("memory");
    expect(sectionIds).not.toContain("git");
    expect(sectionIds).not.toContain("confined-root");
    expect(sections.every((s) => s.available)).toBe(true);
  });

  it("marks confined-root sections unavailable for work without a bound root", () => {
    const sections = filterEnvironmentSections("work", { hasBoundRoot: false });
    const confinedRoot = sections.find((s) => s.id === "confined-root");
    expect(confinedRoot?.available).toBe(false);
    expect(confinedRoot?.unavailableReason).toBeDefined();
  });

  it("marks confined-root sections available for work with a bound root", () => {
    const sections = filterEnvironmentSections("work", { hasBoundRoot: true });
    expect(sections.find((s) => s.id === "confined-root")?.available).toBe(true);
  });

  it("exposes code git sections only with a bound root", () => {
    const available = filterEnvironmentSections("code", { hasBoundRoot: true });
    expect(available.find((s) => s.id === "git")?.available).toBe(true);
    const unavailable = filterEnvironmentSections("code", { hasBoundRoot: false });
    expect(unavailable.find((s) => s.id === "git")?.available).toBe(false);
    expect(unavailable.find((s) => s.id === "git")?.unavailableReason).toBeDefined();
  });

  it("always exposes notepad and project instructions for code", () => {
    const sections = filterEnvironmentSections("code", { hasBoundRoot: false });
    expect(sections.find((s) => s.id === "notepad")?.available).toBe(true);
    expect(sections.find((s) => s.id === "project-instructions")?.available).toBe(true);
  });

  it("fails closed when authoritative Chat thread context is unavailable", () => {
    const sections = filterEnvironmentSections("chat", {
      hasBoundRoot: false,
      hasAuthoritativeContext: false,
      hasProjectMemory: false,
    });
    expect(sections.map((candidate) => candidate.id)).toEqual([
      "project-context",
      "memory",
      "attachments",
      "sources",
      "recap",
    ]);
    expect(sections.every((candidate) => !candidate.available)).toBe(true);
    expect(sections.every((candidate) => candidate.unavailableReason !== undefined)).toBe(true);
  });
});

describe("chat environment projection", () => {
  it("projects a named virtual Project without filesystem or approval sections", () => {
    const projection = deriveChatEnvironmentProjection({
      controllerStatus: "ready",
      hasAuthoritativeThread: true,
      projectName: "Planning",
      threadHasProject: true,
    });
    expect(projection.identity).toMatchObject({
      label: "Planning",
      detail: "Virtual Project",
      status: "available",
    });
    expect(
      projection.sections.filter((section) => section.available).map((section) => section.id),
    ).toEqual(["project-context", "memory", "attachments", "sources", "recap"]);
    expect(projection.sections.map((section) => section.id)).not.toEqual(
      expect.arrayContaining(["git", "confined-root", "artifacts", "approvals"]),
    );
  });

  it("keeps unfiled Chat context explicit and project memory unavailable", () => {
    const projection = deriveChatEnvironmentProjection({
      controllerStatus: "ready",
      hasAuthoritativeThread: true,
      threadHasProject: false,
    });
    expect(projection.identity).toMatchObject({
      label: "Unfiled Chat",
      detail: "Virtual context",
      status: "available",
    });
    expect(projection.sections.find((section) => section.id === "memory")?.available).toBe(false);
    expect(projection.sections.find((section) => section.id === "attachments")?.available).toBe(
      true,
    );
  });

  it("fails closed when a referenced Chat Project cannot be resolved", () => {
    const projection = deriveChatEnvironmentProjection({
      controllerStatus: "ready",
      hasAuthoritativeThread: true,
      threadHasProject: true,
    });
    expect(projection.identity).toMatchObject({
      label: "Chat",
      detail: "Project unavailable",
      status: "unavailable",
    });
    expect(projection.sections.every((section) => !section.available)).toBe(true);
  });

  it("keeps loading and disconnected context visibly fail closed", () => {
    const loading = deriveChatEnvironmentProjection({
      controllerStatus: "loading",
      hasAuthoritativeThread: false,
      threadHasProject: false,
    });
    expect(loading.identity).toMatchObject({ detail: "Loading context", status: "recovery" });
    expect(loading.sections.every((section) => !section.available)).toBe(true);

    const disconnected = deriveChatEnvironmentProjection({
      controllerStatus: "disconnected",
      hasAuthoritativeThread: false,
      threadHasProject: false,
    });
    expect(disconnected.identity).toMatchObject({
      detail: "Reconnecting",
      status: "disconnected",
    });
    expect(disconnected.sections.every((section) => !section.available)).toBe(true);
  });
});

describe("environment compact identity", () => {
  it("builds a compact identity for a ready code context", () => {
    const identity = buildCompactIdentity({
      host: baseHost(),
      label: "Local",
      detail: "feature/name",
      status: "available",
    });
    expect(identity.detail).toBe("feature/name");
    expect(identity.status).toBe("available");
  });

  it("builds a compact identity for an unavailable state", () => {
    const identity = buildCompactIdentity({
      host: baseHost(),
      label: "Local",
      detail: "worktree",
      status: "unavailable",
    });
    expect(identity.status).toBe("unavailable");
  });
});

const codeEnvironmentProjectId = decodeProjectId("11111111-1111-4111-8111-111111111111");

function readyObservation(
  overrides: Partial<CodeEnvironmentObservation> = {},
): CodeEnvironmentObservation {
  return decodeCodeEnvironmentObservation({
    status: "ready",
    projectId: codeEnvironmentProjectId,
    projectName: "Octant",
    repositoryRoot: "/Users/example/Dev/Repos/octant",
    worktreeRoot: "/Users/example/Dev/Repos/octant/.worktrees/issue-204",
    branch: { kind: "named", name: "feature/issue-204" },
    changes: "dirty",
    observedAt: "2026-07-23T20:00:00.000Z",
    ...overrides,
  });
}

function failureObservation(
  status: "unavailable" | "failed",
  reason: string,
): CodeEnvironmentObservation {
  return decodeCodeEnvironmentObservation({
    status,
    projectId: codeEnvironmentProjectId,
    projectName: "Octant",
    reason,
    observedAt: "2026-07-23T20:00:00.000Z",
  });
}

describe("code environment projection", () => {
  it("projects an available identity with the branch name as detail for a ready observation", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: readyObservation(),
      projectName: "Octant",
      controllerStatus: "ready",
    });
    expect(projection.identity.host).toBe("local");
    expect(projection.identity.label).toBe("Octant");
    expect(projection.identity.detail).toBe("feature/issue-204");
    expect(projection.identity.status).toBe("available");
  });

  it("uses a short detached oid as detail when the branch is detached", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: readyObservation({ branch: { kind: "detached", oid: "a".repeat(40) } }),
      projectName: "Octant",
      controllerStatus: "ready",
    });
    expect(projection.identity.detail).toBe(`detached ${"a".repeat(12)}`);
    expect(projection.identity.status).toBe("available");
  });

  it("reports a recovery identity while the controller is loading", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: undefined,
      projectName: "Octant",
      controllerStatus: "loading",
    });
    expect(projection.identity.status).toBe("recovery");
    expect(projection.identity.detail).toBe("Loading environment");
  });

  it("reports a disconnected identity when the controller errors", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: undefined,
      projectName: "Octant",
      controllerStatus: "error",
    });
    expect(projection.identity.status).toBe("disconnected");
    expect(projection.identity.detail).toBe("Reconnecting");
  });

  it("reports an unavailable identity when no project is bound", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: undefined,
      projectName: "Octant",
      controllerStatus: "idle",
    });
    expect(projection.identity.status).toBe("unavailable");
    expect(projection.identity.detail).toBe("No project");
  });

  it("reports an unavailable identity when the observation is unavailable", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: failureObservation(
        "unavailable",
        "Git is not initialized for this Code Project.",
      ),
      projectName: "Octant",
      controllerStatus: "ready",
    });
    expect(projection.identity.status).toBe("unavailable");
    expect(projection.identity.detail).toBe("Environment unavailable");
  });

  it("reports a recovery identity when the observation failed", () => {
    const projection = deriveCodeEnvironmentProjection({
      observation: failureObservation("failed", "Octant could not inspect Git state."),
      projectName: "Octant",
      controllerStatus: "ready",
    });
    expect(projection.identity.status).toBe("recovery");
    expect(projection.identity.detail).toBe("Environment inspection failed");
  });

  it("exposes capability-valid code sections only when the observation is ready", () => {
    const ready = deriveCodeEnvironmentProjection({
      observation: readyObservation(),
      projectName: "Octant",
      controllerStatus: "ready",
    });
    const readyIds = ready.sections.filter((s) => s.available).map((s) => s.id);
    expect(readyIds).toContain("git");
    expect(readyIds).toContain("branch");
    expect(readyIds).not.toContain("confined-root");

    const notReady = deriveCodeEnvironmentProjection({
      observation: undefined,
      projectName: "Octant",
      controllerStatus: "loading",
    });
    const unavailableGit = notReady.sections.find((s) => s.id === "git");
    expect(unavailableGit?.available).toBe(false);
  });
});

describe("work environment projection", () => {
  it("projects confined-root identity from the bound Project root", () => {
    const projection = deriveWorkEnvironmentProjection({
      projectName: "Knowledge Base",
      boundRoot: "/Users/example/Documents/work-root",
    });
    expect(projection.identity.host).toBe("local");
    expect(projection.identity.label).toBe("Knowledge Base");
    expect(projection.identity.detail).toBe("work-root");
    expect(projection.identity.status).toBe("available");
    expect(projection.sections.find((section) => section.id === "confined-root")?.available).toBe(
      true,
    );
    expect(projection.sections.find((section) => section.id === "git")).toBeUndefined();
  });

  it("reports unavailable identity and gated sections without a bound root", () => {
    const projection = deriveWorkEnvironmentProjection({
      projectName: "Knowledge Base",
    });
    expect(projection.identity.status).toBe("unavailable");
    expect(projection.identity.detail).toBe("No folder Project");
    expect(projection.sections.find((section) => section.id === "confined-root")?.available).toBe(
      false,
    );
  });
});
