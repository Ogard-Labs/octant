import {
  decodeLayoutNodeId,
  decodePaneId,
  decodeWindowId,
  decodeWorkspaceOperation,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
  type PaneId,
  type ShellSettings,
  type WindowWorkspace,
  type WorkspaceLayoutNode,
  type WorkspacePane,
  type WorkspaceTab,
} from "@octant/contracts/shell";
import type { CodeEnvironmentObservation } from "@octant/contracts";
import { decodeCodeEnvironmentObservation, decodeWorkThreadId } from "@octant/contracts";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeChatThreadId } from "@octant/contracts/chat";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { describe, expect, it } from "vitest";
import {
  MAX_LAYOUT_DEPTH,
  MAX_WORKSPACE_PANES,
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
  resolveSurfaceDescriptors,
  resolveWorkspaceContext,
  sameWorkspaceSurface,
  validateWorkspace,
} from "./shellPolicy";

const ids = {
  window: decodeWindowId("00000000-0000-4000-8000-000000000001"),
  tabA: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000101"),
  tabB: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000102"),
  tabC: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000103"),
  paneA: decodePaneId("00000000-0000-4000-8000-000000000201"),
  paneB: decodePaneId("00000000-0000-4000-8000-000000000202"),
  nodeA: decodeLayoutNodeId("00000000-0000-4000-8000-000000000301"),
  nodeB: decodeLayoutNodeId("00000000-0000-4000-8000-000000000302"),
  splitA: decodeLayoutNodeId("00000000-0000-4000-8000-000000000401"),
  splitB: decodeLayoutNodeId("00000000-0000-4000-8000-000000000402"),
  nodeC: decodeLayoutNodeId("00000000-0000-4000-8000-000000000303"),
  paneC: decodePaneId("00000000-0000-4000-8000-000000000203"),
  project: decodeProjectId("00000000-0000-4000-8000-000000000501"),
  thread: decodeChatThreadId("00000000-0000-4000-8000-000000000601"),
  codeThread: decodeCodeThreadId("00000000-0000-4000-8000-000000000602"),
};

const welcomeSurface = (id = ids.tabA, mode: "chat" | "work" | "code" = "code") =>
  decodeWorkspaceTab({ kind: "welcome", id, mode, title: `Surface ${id.slice(-3)}` });

const settingsSurface = (id = ids.tabA) =>
  decodeWorkspaceTab({ kind: "settings", id, title: "Settings" });

const overviewSurface = (id = ids.tabA, title = "Overview") =>
  decodeWorkspaceTab({ kind: "code-overview", id, threadId: ids.codeThread, mode: "code", title });

function onlyPane(layout: WorkspaceLayoutNode) {
  expect(layout.kind).toBe("pane");
  if (layout.kind !== "pane") throw new Error("expected pane");
  return layout;
}

function codePane(workspace: WindowWorkspace) {
  return onlyPane(workspace.layouts.code);
}

function withCodeSurface(workspace: WindowWorkspace, surface: WorkspaceTab): WindowWorkspace {
  const code = codePane(workspace);
  return {
    ...workspace,
    layouts: { ...workspace.layouts, code: { ...code, surface } },
  };
}

describe("Code surface mode authority", () => {
  it("accepts Code surfaces only in the Code layout", () => {
    const codeSurface = overviewSurface();
    const workspace = defaultWindowWorkspace(ids.window);
    expect(validateWorkspace(withCodeSurface(workspace, codeSurface))).toBeDefined();

    const chat = onlyPane(workspace.layouts.chat);
    expect(() =>
      validateWorkspace({
        ...workspace,
        layouts: { ...workspace.layouts, chat: { ...chat, surface: codeSurface } },
      }),
    ).toThrow(ShellPolicyRejected);
  });
});

function firstPaneId(layout: WorkspaceLayoutNode): PaneId {
  return layout.kind === "pane" ? layout.paneId : firstPaneId(layout.first);
}

function codeLayoutWithPanes(paneCount: number): WorkspaceLayoutNode {
  const panes: ReadonlyArray<WorkspacePane> = Array.from({ length: paneCount }, (_, index) => {
    const tabId = decodeWorkspaceTabId(
      `a3000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    return {
      kind: "pane",
      nodeId: decodeLayoutNodeId(`a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      paneId: decodePaneId(`a2000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
      surface: welcomeSurface(tabId),
    };
  });
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
  return join(panes);
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
      workspaceMaterial: "opaque",
      modeSwitcherPresentation: "dropdown",
      projectViewSwitcherPresentation: "dropdown",
      transcriptTextSize: "medium",
      transcriptWidth: "narrow",
      showThreadProviderIcons: true,
      openInApplications: ["vscode", "cursor", "zed", "finder", "terminal", "ghostty", "xcode"],
      sidebarBackground: {
        kind: "none",
        overlayColor: "#1a1a1c",
        overlayOpacity: 100,
        vibrancyMode: "subtle",
      },
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "floating" },
      firstRunOnboarding: "pending",
      automaticUpdateChecks: true,
      marketplaceFetchesEnabled: true,
      // Navigator starts honestly unconfigured: no default model, no reviewer.
      navigatorAssistant: {},
      // Voice starts unconfigured: no transcription or synthesis endpoint.
      voice: {},
      // The host has not been told who is using it, so the profile carries no
      // name and no address — only the accent the initials avatar falls back to.
      userProfile: { accent: "indigo", avatar: { kind: "initials" } },
    });
    expect(replaceShellSettings(current, replacement)).toEqual({
      ...replacement,
      sidebarWidth: 420,
      contextSidebarWidth: 960,
      environmentPresentationByMode: { chat: "hidden", work: "floating", code: "floating" },
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
    expect(
      replaceShellSettings(current, { ...replacement, workspaceMaterial: "system" })
        .workspaceMaterial,
    ).toBe("system");
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
  it("builds independent single-pane welcome layouts for every mode with Chat active", () => {
    const workspace = defaultWindowWorkspace(ids.window);

    expect(workspace.activeMode).toBe("chat");
    expect(workspace.activePaneIds).toEqual({
      chat: onlyPane(workspace.layouts.chat).paneId,
      work: onlyPane(workspace.layouts.work).paneId,
      code: onlyPane(workspace.layouts.code).paneId,
    });
    expect(workspace.focusedPaneId).toBeUndefined();
    expect(workspace.version).toBe(0);
    expect(
      Object.entries(workspace.layouts).map(([mode, layout]) => [mode, onlyPane(layout).surface]),
    ).toEqual([
      ["chat", expect.objectContaining({ kind: "welcome", mode: "chat" })],
      ["work", expect.objectContaining({ kind: "welcome", mode: "work" })],
      ["code", expect.objectContaining({ kind: "welcome", mode: "code" })],
    ]);
    expect(() => validateWorkspace(workspace)).not.toThrow();
  });

  it("rejects duplicate identities, unreachable focus and active panes, and limits", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codePane(base);
    const expectRejected = (workspace: WindowWorkspace) =>
      expect(() => validateWorkspace(workspace)).toThrow(ShellPolicyRejected);

    expectRejected({ ...base, layouts: { ...base.layouts, work: base.layouts.chat } });
    expectRejected({ ...base, focusedPaneId: ids.paneA });
    expectRejected({ ...base, focusedPaneId: onlyPane(base.layouts.code).paneId });
    expectRejected({
      ...base,
      activePaneIds: { ...base.activePaneIds, code: onlyPane(base.layouts.chat).paneId },
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
          paneId: decodePaneId(`30000000-0000-4000-8000-${String(depth).padStart(12, "0")}`),
          surface: welcomeSurface(
            decodeWorkspaceTabId(`40000000-0000-4000-8000-${String(depth).padStart(12, "0")}`),
          ),
        },
      };
    }
    expectRejected({ ...base, layouts: { ...base.layouts, code: deep } });

    expectRejected({
      ...base,
      layouts: { ...base.layouts, code: codeLayoutWithPanes(MAX_WORKSPACE_PANES + 1) },
      activePaneIds: {
        ...base.activePaneIds,
        code: firstPaneId(codeLayoutWithPanes(MAX_WORKSPACE_PANES + 1)),
      },
    });
  });

  it("rejects welcome surfaces whose mode differs from the enclosing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyPane(base.layouts.chat);

    expect(() =>
      validateWorkspace({
        ...base,
        layouts: { ...base.layouts, chat: { ...chat, surface: welcomeSurface(ids.tabA) } },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("rejects Chat thread surfaces outside Chat layouts and accepts them in Chat", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyPane(base.layouts.chat);
    const code = onlyPane(base.layouts.code);
    const chatThreadSurface = decodeWorkspaceTab({
      kind: "chat-thread",
      id: ids.tabA,
      threadId: ids.thread,
      mode: "chat",
      title: "Planning",
    });

    expect(
      validateWorkspace({
        ...base,
        layouts: { ...base.layouts, chat: { ...chat, surface: chatThreadSurface } },
      }),
    ).toMatchObject({
      layouts: { chat: { surface: chatThreadSurface } },
    });
    expect(() =>
      validateWorkspace({
        ...base,
        layouts: { ...base.layouts, code: { ...code, surface: chatThreadSurface } },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("rejects Project surfaces whose mode differs from the enclosing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chat = onlyPane(base.layouts.chat);
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
        layouts: { ...base.layouts, chat: { ...chat, surface: mismatched } },
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("accepts a layout exactly at depth 6", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeLayoutWithPanes(MAX_LAYOUT_DEPTH);
    const workspace = {
      ...base,
      layouts: { ...base.layouts, code },
      activePaneIds: { ...base.activePaneIds, code: firstPaneId(code) },
    };

    expect(validateWorkspace(workspace)).toBe(workspace);
  });

  it("accepts exactly 8 panes across the workspace", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codeLayoutWithPanes(MAX_WORKSPACE_PANES - 2);
    const workspace = {
      ...base,
      layouts: { ...base.layouts, code },
      activePaneIds: { ...base.activePaneIds, code: firstPaneId(code) },
    };

    expect(validateWorkspace(workspace)).toBe(workspace);
  });
});

describe("workspace surface identity", () => {
  it("treats two welcome placeholders as distinct so a split may hold several", () => {
    expect(sameWorkspaceSurface(welcomeSurface(ids.tabA), welcomeSurface(ids.tabB))).toBe(false);
  });

  it("recognizes the same thread under a freshly minted surface id", () => {
    expect(
      sameWorkspaceSurface(
        overviewSurface(ids.tabA, "One title"),
        overviewSurface(ids.tabB, "Another"),
      ),
    ).toBe(true);
  });

  it("keeps two files of one thread distinct by path and two terminals by identity", () => {
    const file = (id: typeof ids.tabA, relativePath: string) =>
      decodeWorkspaceTab({
        kind: "code-file",
        id,
        threadId: ids.codeThread,
        mode: "code",
        title: relativePath,
        relativePath,
      });
    expect(sameWorkspaceSurface(file(ids.tabA, "src/a.ts"), file(ids.tabB, "src/a.ts"))).toBe(true);
    expect(sameWorkspaceSurface(file(ids.tabA, "src/a.ts"), file(ids.tabB, "src/b.ts"))).toBe(
      false,
    );

    const terminal = (id: typeof ids.tabA, terminalId?: string) =>
      decodeWorkspaceTab({
        kind: "code-terminal",
        id,
        threadId: ids.codeThread,
        mode: "code",
        title: "Terminal",
        ...(terminalId === undefined ? {} : { terminalId }),
      });
    const shellA = "00000000-0000-4000-8000-00000000e001";
    const shellB = "00000000-0000-4000-8000-00000000e002";
    expect(sameWorkspaceSurface(terminal(ids.tabA, shellA), terminal(ids.tabB, shellA))).toBe(true);
    expect(sameWorkspaceSurface(terminal(ids.tabA, shellA), terminal(ids.tabB, shellB))).toBe(
      false,
    );
  });
});

describe("workspace operations", () => {
  it("rejects opening a welcome surface into a different mode layout", () => {
    const base = defaultWindowWorkspace(ids.window);

    expect(() =>
      applyWorkspaceOperation(base, {
        kind: "open-surface",
        mode: "chat",
        paneId: onlyPane(base.layouts.chat).paneId,
        surface: welcomeSurface(ids.tabA),
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("opening a surface replaces the target pane's content instead of adding a view", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({
        kind: "open-surface",
        mode: "code",
        paneId,
        surface: overviewSurface(ids.tabA),
      }),
    );

    expect(opened.layouts.code.kind).toBe("pane");
    expect(codePane(opened).surface).toMatchObject({ kind: "code-overview", id: ids.tabA });
    expect(opened.activePaneIds.code).toBe(paneId);
    expect(opened.version).toBe(base.version + 1);
  });

  it("opening a surface already visible in another pane activates that pane instead of duplicating it", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(base, {
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(ids.tabA),
    });
    const split = applyWorkspaceOperation(opened, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: settingsSurface(ids.tabB),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });
    expect(split.activePaneIds.code).toBe(ids.paneB);

    // A second open of the same thread carries a freshly minted surface id;
    // the workspace must find the existing view rather than mint another.
    const reopened = applyWorkspaceOperation(split, {
      kind: "open-surface",
      mode: "code",
      paneId: ids.paneB,
      surface: overviewSurface(ids.tabC),
    });
    expect(reopened.activePaneIds.code).toBe(paneId);
    expect(reopened.layouts.code).toEqual(split.layouts.code);
  });

  it("moves the zoom to the pane showing the opened surface while a pane is focused", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(base, {
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(ids.tabA),
    });
    const split = applyWorkspaceOperation(opened, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: settingsSurface(ids.tabB),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });
    const zoomed = applyWorkspaceOperation(split, {
      kind: "focus-pane",
      mode: "code",
      paneId: ids.paneB,
    });
    expect(zoomed.focusedPaneId).toBe(ids.paneB);

    const reopened = applyWorkspaceOperation(zoomed, {
      kind: "open-surface",
      mode: "code",
      paneId: ids.paneB,
      surface: overviewSurface(ids.tabC),
    });
    expect(reopened.focusedPaneId).toBe(paneId);
    expect(reopened.activePaneIds.code).toBe(paneId);
  });

  it("splits a pane on each edge and places the new surface in the new pane", () => {
    for (const [orientation, placement] of [
      ["horizontal", "before"],
      ["horizontal", "after"],
      ["vertical", "before"],
      ["vertical", "after"],
    ] as const) {
      const base = defaultWindowWorkspace(ids.window);
      const paneId = codePane(base).paneId;
      const split = applyWorkspaceOperation(
        base,
        decodeWorkspaceOperation({
          kind: "split-pane",
          mode: "code",
          targetPaneId: paneId,
          surface: overviewSurface(ids.tabA),
          splitNodeId: ids.splitA,
          newPaneNodeId: ids.nodeB,
          newPaneId: ids.paneB,
          orientation,
          placement,
          ratio: 0.7,
        }),
      );

      expect(split.layouts.code).toMatchObject({
        kind: "split",
        nodeId: ids.splitA,
        orientation,
        ratio: 0.7,
        [placement === "before" ? "first" : "second"]: {
          kind: "pane",
          paneId: ids.paneB,
          surface: { id: ids.tabA },
        },
        [placement === "before" ? "second" : "first"]: { kind: "pane", paneId },
      });
      expect(split.activePaneIds.code).toBe(ids.paneB);
    }
  });

  it("moves an already-visible surface into an edge drop instead of duplicating it", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(base, {
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(ids.tabA),
    });
    const split = applyWorkspaceOperation(opened, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: settingsSurface(ids.tabB),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });

    // Drag the overview (visible in the first pane) onto the settings pane's
    // edge: its old pane collapses and the surviving surface keeps its id.
    const moved = applyWorkspaceOperation(split, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: ids.paneB,
      surface: overviewSurface(ids.tabC),
      splitNodeId: ids.splitB,
      newPaneNodeId: ids.nodeC,
      newPaneId: ids.paneC,
      orientation: "vertical",
      placement: "before",
      ratio: 0.5,
    });

    expect(moved.layouts.code).toMatchObject({
      kind: "split",
      nodeId: ids.splitB,
      first: { kind: "pane", paneId: ids.paneC, surface: { kind: "code-overview", id: ids.tabA } },
      second: { kind: "pane", paneId: ids.paneB, surface: { kind: "settings" } },
    });
  });

  it("refuses to split a pane off itself", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(base, {
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(ids.tabA),
    });

    expect(() =>
      applyWorkspaceOperation(opened, {
        kind: "split-pane",
        mode: "code",
        targetPaneId: paneId,
        surface: overviewSurface(ids.tabB),
        splitNodeId: ids.splitA,
        newPaneNodeId: ids.nodeB,
        newPaneId: ids.paneB,
        orientation: "horizontal",
        placement: "after",
        ratio: 0.5,
      }),
    ).toThrow(ShellPolicyRejected);
  });

  it("a center drop replaces the pane's surface, collapsing the source pane of a visible surface", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const opened = applyWorkspaceOperation(base, {
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(ids.tabA),
    });
    const split = applyWorkspaceOperation(opened, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: settingsSurface(ids.tabB),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });

    const replaced = applyWorkspaceOperation(split, {
      kind: "replace-pane-surface",
      mode: "code",
      paneId: ids.paneB,
      surface: overviewSurface(ids.tabC),
    });

    // Two panes held overview and settings; dropping the overview on the
    // settings pane's center leaves one pane showing the overview.
    expect(replaced.layouts.code).toMatchObject({
      kind: "pane",
      paneId: ids.paneB,
      surface: { kind: "code-overview", id: ids.tabA },
    });
    expect(replaced.activePaneIds.code).toBe(ids.paneB);
  });

  it("closing a pane collapses its split and closing the last pane resets to welcome", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const split = applyWorkspaceOperation(base, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: overviewSurface(ids.tabA),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });

    const collapsed = applyWorkspaceOperation(split, {
      kind: "close-pane",
      mode: "code",
      paneId,
    });
    expect(collapsed.layouts.code).toMatchObject({ kind: "pane", paneId: ids.paneB });
    expect(collapsed.activePaneIds.code).toBe(ids.paneB);

    const emptied = applyWorkspaceOperation(collapsed, {
      kind: "close-pane",
      mode: "code",
      paneId: ids.paneB,
    });
    expect(codePane(emptied).surface).toMatchObject({ kind: "welcome", mode: "code" });
  });

  it("clamps resize ratios to the supported range", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const split = applyWorkspaceOperation(base, {
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: overviewSurface(ids.tabA),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "horizontal",
      placement: "after",
      ratio: 0.5,
    });

    const resized = applyWorkspaceOperation(split, {
      kind: "resize-split",
      mode: "code",
      splitNodeId: ids.splitA,
      ratio: 9,
    });
    expect(resized.layouts.code).toMatchObject({ ratio: 0.8 });
  });

  it("focuses only reachable active-mode panes, unfocuses, resets, and switches modes", () => {
    const base = { ...defaultWindowWorkspace(ids.window), activeMode: "code" as const };
    const codePaneId = codePane(base).paneId;
    const focused = applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({ kind: "focus-pane", mode: "code", paneId: codePaneId }),
    );
    expect(focused.focusedPaneId).toBe(codePaneId);
    expect(focused.activePaneIds.code).toBe(codePaneId);

    expect(() =>
      applyWorkspaceOperation(
        focused,
        decodeWorkspaceOperation({
          kind: "focus-pane",
          mode: "chat",
          paneId: onlyPane(base.layouts.chat).paneId,
        }),
      ),
    ).toThrow(ShellPolicyRejected);

    const unfocused = applyWorkspaceOperation(
      focused,
      decodeWorkspaceOperation({ kind: "unfocus-pane", mode: "code" }),
    );
    expect(unfocused.focusedPaneId).toBeUndefined();

    const switched = applyWorkspaceOperation(
      focused,
      decodeWorkspaceOperation({ kind: "set-active-mode", mode: "chat" }),
    );
    expect(switched.activeMode).toBe("chat");
    expect(switched.focusedPaneId).toBeUndefined();

    const changedChat = applyWorkspaceOperation(
      switched,
      decodeWorkspaceOperation({
        kind: "open-surface",
        mode: "chat",
        paneId: onlyPane(switched.layouts.chat).paneId,
        surface: { kind: "settings", id: ids.tabC, title: "Settings" },
      }),
    );
    const reset = applyWorkspaceOperation(
      changedChat,
      decodeWorkspaceOperation({ kind: "reset-mode", mode: "chat" }),
    );
    expect(onlyPane(reset.layouts.chat).surface).toMatchObject({ kind: "welcome", mode: "chat" });
    expect(reset.layouts.code).toBe(changedChat.layouts.code);
  });

  it("rejects malformed references, duplicate identities, and colliding splits", () => {
    const base = defaultWindowWorkspace(ids.window);
    const paneId = codePane(base).paneId;
    const existingSurface = codePane(base).surface;
    const rejectOp = (operation: Parameters<typeof applyWorkspaceOperation>[1]) =>
      expect(() => applyWorkspaceOperation(base, operation)).toThrow(ShellPolicyRejected);

    rejectOp({
      kind: "open-surface",
      mode: "code",
      paneId: ids.paneA,
      surface: overviewSurface(ids.tabA),
    });
    rejectOp({
      kind: "open-surface",
      mode: "code",
      paneId,
      surface: overviewSurface(existingSurface.id),
    });
    rejectOp({ kind: "close-pane", mode: "code", paneId: ids.paneA });
    rejectOp({
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: overviewSurface(ids.tabA),
      splitNodeId: codePane(base).nodeId,
      newPaneNodeId: ids.nodeB,
      newPaneId: ids.paneB,
      orientation: "vertical",
      placement: "after",
      ratio: 0.5,
    });
    rejectOp({
      kind: "split-pane",
      mode: "code",
      targetPaneId: paneId,
      surface: overviewSurface(ids.tabA),
      splitNodeId: ids.splitA,
      newPaneNodeId: ids.nodeB,
      newPaneId: paneId,
      orientation: "vertical",
      placement: "after",
      ratio: 0.5,
    });
  });
});

describe("workspace context validation", () => {
  it("rejects Browser and Files surfaces when the mode context has no bound root", () => {
    const base = defaultWindowWorkspace(ids.window);
    const browserSurface = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    expect(() => validateWorkspace(withCodeSurface(base, browserSurface))).toThrow(
      ShellPolicyRejected,
    );
  });

  it("accepts Browser and Files surfaces when the mode context binds a root", () => {
    const base = defaultWindowWorkspace(ids.window);
    const browserSurface = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    const bound: WindowWorkspace = {
      ...withCodeSurface(base, browserSurface),
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
    };
    expect(validateWorkspace(bound)).toBeDefined();
  });

  it("accepts a Project surface whose Project differs from the mode context (authority enforced at server boundary)", () => {
    const base = defaultWindowWorkspace(ids.window);
    const projectSurface = decodeWorkspaceTab({
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
        ...withCodeSurface(base, projectSurface),
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
      } satisfies WindowWorkspace),
    ).not.toThrow();
  });
});

describe("set-side-chat-sidecar", () => {
  const sidecarThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000201");
  const sourceThreadId = "00000000-0000-4000-8000-000000000101";

  function workspaceWithSideChat(sidecar?: string) {
    const base = defaultWindowWorkspace(ids.window);
    const work = onlyPane(base.layouts.work);
    const surface = decodeWorkspaceTab({
      kind: "side-chat",
      id: ids.tabA,
      mode: "work",
      title: "Side Chat about Release notes",
      sourceThreadId,
      ...(sidecar === undefined ? {} : { sidecarThreadId: sidecar }),
    });
    return applyWorkspaceOperation(
      base,
      decodeWorkspaceOperation({
        kind: "open-surface",
        mode: "work",
        paneId: work.paneId,
        surface,
      }),
    );
  }

  it("records the sidecar a Side Chat pane was showing so a restart can reopen it", () => {
    const opened = workspaceWithSideChat();
    const work = onlyPane(opened.layouts.work);
    const recorded = applyWorkspaceOperation(
      opened,
      decodeWorkspaceOperation({
        kind: "set-side-chat-sidecar",
        mode: "work",
        paneId: work.paneId,
        sidecarThreadId,
      }),
    );
    const surface = onlyPane(recorded.layouts.work).surface;
    expect(surface.kind).toBe("side-chat");
    if (surface.kind !== "side-chat") throw new Error("expected a Side Chat surface");
    expect(String(surface.sidecarThreadId)).toBe(String(sidecarThreadId));
  });

  it("is a no-op when the pane already names that sidecar", () => {
    const opened = workspaceWithSideChat(String(sidecarThreadId));
    const work = onlyPane(opened.layouts.work);
    const recorded = applyWorkspaceOperation(
      opened,
      decodeWorkspaceOperation({
        kind: "set-side-chat-sidecar",
        mode: "work",
        paneId: work.paneId,
        sidecarThreadId,
      }),
    );
    const surface = onlyPane(recorded.layouts.work).surface;
    if (surface.kind !== "side-chat") throw new Error("expected a Side Chat surface");
    expect(String(surface.sidecarThreadId)).toBe(String(sidecarThreadId));
  });

  it("refuses to swap a Side Chat pane onto a different sidecar", () => {
    const opened = workspaceWithSideChat("00000000-0000-4000-8000-000000000202");
    const work = onlyPane(opened.layouts.work);
    expect(() =>
      applyWorkspaceOperation(
        opened,
        decodeWorkspaceOperation({
          kind: "set-side-chat-sidecar",
          mode: "work",
          paneId: work.paneId,
          sidecarThreadId,
        }),
      ),
    ).toThrow(ShellPolicyRejected);
  });

  it("rejects the operation for a pane that does not show Side Chat", () => {
    const base = defaultWindowWorkspace(ids.window);
    const work = onlyPane(base.layouts.work);
    expect(() =>
      applyWorkspaceOperation(
        base,
        decodeWorkspaceOperation({
          kind: "set-side-chat-sidecar",
          mode: "work",
          paneId: work.paneId,
          sidecarThreadId,
        }),
      ),
    ).toThrow(ShellPolicyRejected);
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
    // are opened within a Code thread via code surface controls, so they are
    // not advertised in the surface catalog.
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
  const projectSurface = decodeWorkspaceTab({
    kind: "project",
    id: ids.tabA,
    projectId: ids.project,
    mode: "code",
    title: "Project",
  });
  const otherProject = decodeProjectId("00000000-0000-4000-8000-000000000502");

  it("anchors an unfiled context to the opened Project surface", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codePane(base);
    const resolved = resolveWorkspaceContext(
      withCodeSurface(base, projectSurface),
      { kind: "open-surface", mode: "code", paneId: code.paneId, surface: projectSurface },
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

  it("rejects opening a Project surface into a context bound to a different Project", () => {
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
        {
          kind: "open-surface",
          mode: "code",
          paneId: codePane(base).paneId,
          surface: projectSurface,
        },
        {
          tabContext: (tab) =>
            tab.kind === "project"
              ? { host, mode: "code", projectId: tab.projectId, boundRoot: "/home/repo" }
              : undefined,
        },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("resolves the context of a surface introduced by an edge drop", () => {
    const base = defaultWindowWorkspace(ids.window);
    const anchored: WindowWorkspace = {
      ...base,
      contextByMode: {
        chat: base.contextByMode.chat,
        work: base.contextByMode.work,
        code: { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" },
      },
    };
    // A sidebar drag lands as split-pane without passing through open-surface;
    // a cross-Project surface must still be refused before layout mutation.
    expect(() =>
      resolveWorkspaceContext(
        anchored,
        {
          kind: "split-pane",
          mode: "code",
          targetPaneId: codePane(base).paneId,
          surface: projectSurface,
          splitNodeId: ids.splitA,
          newPaneNodeId: ids.nodeB,
          newPaneId: ids.paneB,
          orientation: "horizontal",
          placement: "after",
          ratio: 0.5,
        },
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
      kind: "switch-project-surface",
      mode: "code",
      surface: projectSurface,
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
    expect(codePane(switched).surface).toEqual(projectSurface);
  });

  it("stows the outgoing Project layout and restores it when switching back", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codePane(base);
    const threadSurfaceA1 = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabB,
      threadId: ids.codeThread,
      mode: "code",
      title: "A first",
    });
    const threadSurfaceA2 = decodeWorkspaceTab({
      kind: "code-file",
      id: ids.tabC,
      threadId: ids.codeThread,
      mode: "code",
      title: "src/a.ts",
      relativePath: "src/a.ts",
    });
    const splitLayout: WorkspaceLayoutNode = {
      kind: "split",
      nodeId: ids.splitA,
      orientation: "horizontal",
      ratio: 0.5,
      first: { ...code, nodeId: ids.nodeA, paneId: ids.paneA, surface: threadSurfaceA1 },
      second: { ...code, nodeId: ids.nodeB, paneId: ids.paneB, surface: threadSurfaceA2 },
    };
    const anchored: WindowWorkspace = {
      ...base,
      layouts: { ...base.layouts, code: splitLayout },
      activePaneIds: { ...base.activePaneIds, code: ids.paneB },
      contextByMode: {
        ...base.contextByMode,
        code: { host, mode: "code", projectId: otherProject, boundRoot: "/home/other" },
      },
    };
    const switchToB = decodeWorkspaceOperation({
      kind: "switch-project-surface",
      mode: "code",
      surface: projectSurface,
    });
    const resolverB = {
      tabContext: (candidate: typeof projectSurface) =>
        candidate.kind === "project"
          ? { host, mode: "code" as const, projectId: candidate.projectId, boundRoot: "/home/repo" }
          : undefined,
    };
    const inB = applyWorkspaceOperation(
      resolveWorkspaceContext(anchored, switchToB, resolverB),
      switchToB,
    );
    expect(codePane(inB).surface).toEqual(projectSurface);
    expect(inB.stowedLayouts).toHaveLength(1);
    expect(inB.stowedLayouts[0]?.context.projectId).toBe(otherProject);
    expect(inB.stowedLayouts[0]?.layout).toEqual(splitLayout);
    expect(inB.stowedLayouts[0]?.activePaneId).toBe(ids.paneB);

    const returnSurface = decodeWorkspaceTab({
      kind: "project",
      id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000104"),
      projectId: otherProject,
      mode: "code",
      title: "Project A",
    });
    const switchToA = decodeWorkspaceOperation({
      kind: "switch-project-surface",
      mode: "code",
      surface: returnSurface,
    });
    const resolverA = {
      tabContext: (candidate: typeof returnSurface) =>
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
    const restoredFirst = onlyPane(
      backInA.layouts.code.kind === "split" ? backInA.layouts.code.first : backInA.layouts.code,
    );
    expect(restoredFirst.surface).toEqual(threadSurfaceA1);
    // The Project surface replaces the restored active pane's content: a pane
    // holds one surface, so returning to a Project shows its overview where
    // the last-active surface was rather than growing the layout.
    const restoredSecond = onlyPane(
      backInA.layouts.code.kind === "split" ? backInA.layouts.code.second : backInA.layouts.code,
    );
    expect(restoredSecond.surface).toEqual(returnSurface);
    expect(backInA.activePaneIds.code).toBe(ids.paneB);
    expect(backInA.stowedLayouts).toHaveLength(1);
    expect(backInA.stowedLayouts[0]?.context.projectId).toBe(ids.project);
  });

  it("does not stow a welcome-only outgoing layout", () => {
    const base = defaultWindowWorkspace(ids.window);
    const operation = decodeWorkspaceOperation({
      kind: "switch-project-surface",
      mode: "code",
      surface: projectSurface,
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
    expect(codePane(switched).surface).toEqual(projectSurface);
  });

  it("rejects stowed layouts beyond the bounded count or with duplicate contexts", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codePane(base);
    const entry = (index: number) => ({
      context: {
        host,
        mode: "code" as const,
        projectId: decodeProjectId(`b1000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
        boundRoot: `/home/repo-${index}`,
      },
      layout: { ...code, surface: welcomeSurface(ids.tabA) },
      activePaneId: code.paneId,
    });
    const within = { ...base, stowedLayouts: Array.from({ length: 12 }, (_, i) => entry(i)) };
    expect(() => validateWorkspace(within)).not.toThrow();
    const beyond = { ...base, stowedLayouts: Array.from({ length: 13 }, (_, i) => entry(i)) };
    expect(() => validateWorkspace(beyond)).toThrow(ShellPolicyRejected);
    const duplicate = { ...base, stowedLayouts: [entry(1), entry(1)] };
    expect(() => validateWorkspace(duplicate)).toThrow(ShellPolicyRejected);
  });

  it("rejects re-opening a restored thread surface from a different Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const code = codePane(base);
    const threadSurface = decodeWorkspaceTab({
      kind: "code-overview",
      id: ids.tabA,
      threadId: ids.codeThread,
      mode: "code",
      title: "Other Project thread",
    });
    const anchored: WindowWorkspace = {
      ...withCodeSurface(base, threadSurface),
      contextByMode: {
        ...base.contextByMode,
        code: { host, mode: "code", projectId: ids.project, boundRoot: "/home/repo" },
      },
    };

    expect(() =>
      resolveWorkspaceContext(
        anchored,
        {
          kind: "open-surface",
          mode: "code",
          paneId: code.paneId,
          surface: threadSurface,
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
    const browserSurface = decodeWorkspaceTab({
      kind: "browser",
      id: ids.tabA,
      mode: "code",
      title: "Browser",
    });
    expect(() =>
      resolveWorkspaceContext(
        base,
        {
          kind: "open-surface",
          mode: "code",
          paneId: codePane(base).paneId,
          surface: browserSurface,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rejects a cross-host surface with a new-window offer", () => {
    const base = defaultWindowWorkspace(ids.window);
    const remoteHost = "remote-host";
    const chatThreadSurface = decodeWorkspaceTab({
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
          kind: "open-surface",
          mode: "chat",
          paneId: onlyPane(base.layouts.chat).paneId,
          surface: chatThreadSurface,
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
      {
        kind: "open-surface",
        mode: "code",
        paneId: codePane(base).paneId,
        surface: projectSurface,
      },
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

  it("rejects a thread surface whose Project context cannot be resolved", () => {
    const base = defaultWindowWorkspace(ids.window);
    const chatThreadSurface = decodeWorkspaceTab({
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
          kind: "open-surface",
          mode: "chat",
          paneId: onlyPane(base.layouts.chat).paneId,
          surface: chatThreadSurface,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it.each(["code", "work"] as const)(
    "refuses to open a %s thread surface whose Project cannot be resolved",
    (mode) => {
      const base = defaultWindowWorkspace(ids.window);
      const layout = onlyPane(base.layouts[mode]);
      const unresolvableSurface = decodeWorkspaceTab(
        mode === "code"
          ? {
              kind: "code-overview",
              id: ids.tabA,
              threadId: ids.codeThread,
              mode,
              title: "Issue 204",
              hostId: base.contextByMode.code.host,
            }
          : {
              kind: "work-thread",
              id: ids.tabA,
              threadId: decodeWorkThreadId("00000000-0000-4000-8000-000000000603"),
              mode,
              title: "Quarterly brief",
              hostId: base.contextByMode.work.host,
            },
      );

      expect(() =>
        resolveWorkspaceContext(
          base,
          { kind: "open-surface", mode, paneId: layout.paneId, surface: unresolvableSurface },
          { tabContext: () => undefined },
        ),
      ).toThrow(WorkspaceContextRejected);
    },
  );

  it("anchors an unbound context to the opened preview surface's Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewSurface = decodeWorkspaceTab({
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
        kind: "open-surface",
        mode: "work",
        paneId: onlyPane(base.layouts.work).paneId,
        surface: previewSurface,
      },
      { tabContext: () => undefined },
    );
    expect(resolved.contextByMode.work.projectId).toBe(ids.project);
  });

  it("allows a same-Project preview surface to coexist with the bound context", () => {
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
    const previewSurface = decodeWorkspaceTab({
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
        kind: "open-surface",
        mode: "work",
        paneId: onlyPane(base.layouts.work).paneId,
        surface: previewSurface,
      },
      { tabContext: () => undefined },
    );
    expect(resolved.contextByMode.work.projectId).toBe(ids.project);
  });

  it("rejects a cross-Project preview surface before layout mutation", () => {
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
    const previewSurface = decodeWorkspaceTab({
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
          kind: "open-surface",
          mode: "work",
          paneId: onlyPane(base.layouts.work).paneId,
          surface: previewSurface,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("rejects a preview surface whose mode does not match the operation mode", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewSurface = decodeWorkspaceTab({
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
          kind: "open-surface",
          mode: "code",
          paneId: onlyPane(base.layouts.code).paneId,
          surface: previewSurface,
        },
        { tabContext: () => undefined },
      ),
    ).toThrow(WorkspaceContextRejected);
  });

  it("validateWorkspace rejects a preview surface in a context with no bound Project", () => {
    const base = defaultWindowWorkspace(ids.window);
    const previewSurface = decodeWorkspaceTab({
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
        work: { ...onlyPane(base.layouts.work), surface: previewSurface },
      },
    };
    expect(() => validateWorkspace(withPreview)).toThrow(ShellPolicyRejected);
  });
});

function baseHost() {
  return defaultWindowWorkspace(ids.window).contextByMode.chat.host;
}

describe("environment presentation policy", () => {
  it("defaults to hidden chat and floating work and code", () => {
    const state = defaultEnvironmentPresentationState();
    expect(state.byMode).toEqual({ chat: "hidden", work: "floating", code: "floating" });
    expect(state.byTab).toEqual([]);
  });

  it("resolves the per-mode default when no tab override exists", () => {
    const state = defaultEnvironmentPresentationState();
    expect(resolveEffectivePresentation(state, "code", ids.tabA)).toBe("floating");
    expect(resolveEffectivePresentation(state, "chat", ids.tabA)).toBe("hidden");
    expect(resolveEffectivePresentation(state, "work", ids.tabA)).toBe("floating");
  });

  it("resolves a tab override over the mode default", () => {
    const state = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "hidden",
    });
    expect(resolveEffectivePresentation(state, "code", ids.tabA)).toBe("hidden");
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

  it("removes a tab override so the mode default applies again", () => {
    const withOverride = replaceEnvironmentPresentation(defaultEnvironmentPresentationState(), {
      tabId: ids.tabA,
      presentation: "floating",
    });
    const removed = removeEnvironmentPresentation(withOverride, ids.tabA);
    expect(resolveEffectivePresentation(removed, "code", ids.tabA)).toBe("floating");
  });

  it("normalizes a full presentation state by keeping the first entry per tab", () => {
    const normalized = normalizeEnvironmentPresentationState({
      byTab: [
        { tabId: ids.tabA, presentation: "floating" },
        { tabId: ids.tabA, presentation: "hidden" },
        { tabId: ids.tabB, presentation: "hidden" },
      ],
      byMode: { chat: "hidden", work: "floating", code: "floating" },
    });
    expect(normalized.byTab).toEqual([
      { tabId: ids.tabA, presentation: "floating" },
      { tabId: ids.tabB, presentation: "hidden" },
    ]);
    expect(normalized.byMode).toEqual({ chat: "hidden", work: "floating", code: "floating" });
  });

  it("includes environment presentation defaults in default shell settings", () => {
    expect(defaultShellSettings().environmentPresentationByMode).toEqual({
      chat: "hidden",
      work: "floating",
      code: "floating",
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
