import { decodeCanvasId } from "@octant/contracts/canvas";
import { decodeProjectId } from "@octant/contracts/projects";
import {
  decodeWorkspaceOperation,
  decodeWorkspaceTab,
  decodeWorkspaceTabId,
} from "@octant/contracts/shell";
import { describe, expect, it } from "vitest";
import { isCanvasTabPinned, orderTabsWithPinnedCanvasFirst } from "./canvasTabPolicy";
import {
  applyWorkspaceOperation,
  defaultWindowWorkspace,
  ShellPolicyRejected,
} from "./shellPolicy";

const windowId = "00000000-0000-4000-8000-000000000001" as never;
const canvasTabId = decodeWorkspaceTabId("00000000-0000-4000-8000-000000000924");
const welcomeTabId = decodeWorkspaceTabId("01000000-0000-4000-8000-000000000003");
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000899");

function canvasTab(pinned?: true) {
  return decodeWorkspaceTab({
    kind: "canvas",
    id: canvasTabId,
    mode: "chat",
    title: "Quarterly summary",
    canvasId,
    projectId,
    ...(pinned === undefined ? {} : { pinned }),
  });
}

function chatWorkspaceWithCanvas() {
  const base = defaultWindowWorkspace(windowId);
  const chat = base.layouts.chat;
  if (chat.kind !== "group") throw new Error("expected group");
  const groupId = chat.groupId;
  return applyWorkspaceOperation(
    {
      ...base,
      contextByMode: {
        ...base.contextByMode,
        chat: { ...base.contextByMode.chat, projectId, boundRoot: null },
      },
    },
    decodeWorkspaceOperation({
      kind: "open-tab",
      mode: "chat",
      groupId,
      tab: canvasTab(),
    }),
  );
}

describe("canvas tab pin policy", () => {
  it("reports unpinned by default and true only when the tab carries pinned", () => {
    expect(isCanvasTabPinned(canvasTab())).toBe(false);
    expect(isCanvasTabPinned(canvasTab(true))).toBe(true);
    expect(
      isCanvasTabPinned(
        decodeWorkspaceTab({ kind: "welcome", id: welcomeTabId, mode: "chat", title: "Welcome" }),
      ),
    ).toBe(false);
  });

  it("pins a canvas tab and keeps pinned tabs at the front of the group", () => {
    const workspace = chatWorkspaceWithCanvas();
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("expected group");
    const groupId = chat.groupId;
    const pinned = applyWorkspaceOperation(
      workspace,
      decodeWorkspaceOperation({
        kind: "set-canvas-tab-pin",
        mode: "chat",
        groupId,
        tabId: canvasTabId,
        pinned: true,
      }),
    );
    const group = pinned.layouts.chat;
    if (group.kind !== "group") throw new Error("expected group");
    const tab = group.tabs.find((candidate) => candidate.id === canvasTabId);
    expect(tab?.kind).toBe("canvas");
    if (tab?.kind !== "canvas") throw new Error("expected canvas");
    expect(tab.pinned).toBe(true);
    expect(group.tabs[0]?.id).toBe(canvasTabId);

    const unpinned = applyWorkspaceOperation(
      pinned,
      decodeWorkspaceOperation({
        kind: "set-canvas-tab-pin",
        mode: "chat",
        groupId,
        tabId: canvasTabId,
        pinned: false,
      }),
    );
    const restored = unpinned.layouts.chat;
    if (restored.kind !== "group") throw new Error("expected group");
    const restoredTab = restored.tabs.find((candidate) => candidate.id === canvasTabId);
    expect(restoredTab?.kind).toBe("canvas");
    if (restoredTab?.kind !== "canvas") throw new Error("expected canvas");
    expect(restoredTab.pinned).toBeUndefined();
  });

  it("rejects pin changes for non-canvas tabs", () => {
    const workspace = chatWorkspaceWithCanvas();
    const chat = workspace.layouts.chat;
    if (chat.kind !== "group") throw new Error("expected group");
    expect(() =>
      applyWorkspaceOperation(
        workspace,
        decodeWorkspaceOperation({
          kind: "set-canvas-tab-pin",
          mode: "chat",
          groupId: chat.groupId,
          tabId: welcomeTabId,
          pinned: true,
        }),
      ),
    ).toThrow(ShellPolicyRejected);
  });
});

describe("orderTabsWithPinnedCanvasFirst", () => {
  it("keeps pinned canvas tabs before unpinned neighbors without changing relative order otherwise", () => {
    const pinned = canvasTab(true);
    const secondCanvas = decodeWorkspaceTab({
      kind: "canvas",
      id: decodeWorkspaceTabId("00000000-0000-4000-8000-000000000925"),
      mode: "chat",
      title: "Roadmap",
      canvasId: decodeCanvasId("22222222-2222-4222-8222-222222222222"),
      projectId,
    });
    const ordered = orderTabsWithPinnedCanvasFirst([
      decodeWorkspaceTab({ kind: "welcome", id: welcomeTabId, mode: "chat", title: "Welcome" }),
      secondCanvas,
      pinned,
    ]);
    expect(ordered.map((tab) => tab.id)).toEqual([pinned.id, welcomeTabId, secondCanvas.id]);
  });
});
