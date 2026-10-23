import { decodeWorkspaceOperation, type WindowWorkspace } from "@octant/contracts";
import { applyWorkspaceOperation } from "@octant/domain/shell-policy";
import { describe, expect, it } from "vitest";
import { chatShellBootstrap } from "../App.test-fixtures";
import { rememberWorkspaceContent, settleThreadPreview } from "./workspaceContentTabs";

const THREADS = [
  "00000000-0000-4000-8000-000000000901",
  "00000000-0000-4000-8000-000000000902",
  "00000000-0000-4000-8000-000000000903",
] as const;

function open(workspace: WindowWorkspace, index: number): WindowWorkspace {
  const layout = workspace.layouts.chat;
  if (layout.kind !== "pane") throw new Error("Expected one Chat pane.");
  return applyWorkspaceOperation(
    workspace,
    decodeWorkspaceOperation({
      kind: "open-surface",
      mode: "chat",
      paneId: String(layout.paneId),
      surface: {
        kind: "chat-thread",
        id: `00000000-0000-4000-8000-00000000091${String(index)}`,
        threadId: THREADS[index],
        mode: "chat",
        title: `Thread ${String(index)}`,
      },
    }),
  );
}

/** Opens threads in order, each through `rememberWorkspaceContent`, and returns the tab titles. */
function tabsAfter(opens: ReadonlyArray<number>, preview: ReadonlySet<string>) {
  let workspace = chatShellBootstrap().workspace;
  let tabs: ReturnType<typeof rememberWorkspaceContent> = new Map();
  for (const index of opens) {
    const next = open(workspace, index);
    tabs = rememberWorkspaceContent(tabs, workspace, next, preview);
    workspace = next;
  }
  return [...tabs.values()].flat().map((tab) => tab.title);
}

describe("opening threads into a pane's tabs", () => {
  it("lets a single-clicked thread take over the open tab instead of adding one", () => {
    expect(tabsAfter([0, 1, 2], new Set(THREADS))).toEqual(["Thread 2"]);
  });

  it("keeps a kept thread's tab and opens the next one beside it", () => {
    // Thread 0 was double-clicked (kept); 1 and 2 were single-clicked.
    expect(tabsAfter([0, 1, 2], new Set([THREADS[1], THREADS[2]]))).toEqual([
      "Thread 0",
      "Thread 2",
    ]);
  });

  it("keeps every tab opened from anywhere else", () => {
    expect(tabsAfter([0, 1, 2], new Set())).toEqual(["Thread 0", "Thread 1", "Thread 2"]);
  });
});

describe("which thread is the single-click preview", () => {
  it("passes the preview to the thread a single click just opened", () => {
    const opened = open(chatShellBootstrap().workspace, 1);
    expect(settleThreadPreview({ current: THREADS[0], pending: THREADS[1] }, opened)).toEqual({
      current: THREADS[1],
    });
  });

  it("forgets a replaced preview, so opening it again another way keeps its tab", () => {
    // Thread 0 was the preview; a search opened thread 2 over it.
    const opened = open(chatShellBootstrap().workspace, 2);
    expect(settleThreadPreview({ current: THREADS[0] }, opened)).toEqual({});
  });

  it("keeps the preview while its thread is still showing", () => {
    const opened = open(chatShellBootstrap().workspace, 0);
    expect(settleThreadPreview({ current: THREADS[0] }, opened)).toEqual({ current: THREADS[0] });
  });
});
