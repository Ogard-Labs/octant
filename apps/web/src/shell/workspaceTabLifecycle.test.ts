import { decodeWorkspaceLayoutNode } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { activeCodeThreadTabId, openLocalCodeThreadIds } from "./workspaceTabLifecycle";

describe("workspace tab lifecycle", () => {
  /**
   * Split view: activating the Browser pane must not unload the Code thread
   * shown in the sibling pane. A utility surface has no thread of its own, so
   * the visible Code thread stays active; a Welcome pane still yields none.
   */
  it("keeps the sibling pane's Code thread active while a utility pane is active", () => {
    const threadId = "00000000-0000-4000-8000-000000000701";
    const utilityPaneId = "00000000-0000-4000-8000-000000000622";
    const layout = (surface: Record<string, unknown>) =>
      decodeWorkspaceLayoutNode({
        kind: "split",
        nodeId: "00000000-0000-4000-8000-000000000610",
        orientation: "horizontal",
        ratio: 0.5,
        first: {
          kind: "pane",
          nodeId: "00000000-0000-4000-8000-000000000611",
          paneId: "00000000-0000-4000-8000-000000000612",
          surface: {
            kind: "code-overview",
            id: "00000000-0000-4000-8000-000000000613",
            threadId,
            mode: "code",
            title: "Thread",
          },
        },
        second: {
          kind: "pane",
          nodeId: "00000000-0000-4000-8000-000000000621",
          paneId: utilityPaneId,
          surface,
        },
      });

    expect(
      activeCodeThreadTabId(
        layout({
          kind: "browser",
          id: "00000000-0000-4000-8000-000000000623",
          mode: "code",
          title: "Browser",
        }),
        utilityPaneId as never,
      ),
    ).toBe(threadId);
    expect(
      activeCodeThreadTabId(
        layout({
          kind: "welcome",
          id: "00000000-0000-4000-8000-000000000624",
          mode: "code",
          title: "Welcome",
        }),
        utilityPaneId as never,
      ),
    ).toBeUndefined();
  });

  it("collects every open Code thread once, however many surfaces it has open", () => {
    const threadA = "00000000-0000-4000-8000-000000000631";
    const threadB = "00000000-0000-4000-8000-000000000632";
    const pane = (ordinal: number, surface: Record<string, unknown>) => ({
      kind: "pane",
      nodeId: `00000000-0000-4000-8000-00000000065${ordinal}`,
      paneId: `00000000-0000-4000-8000-00000000066${ordinal}`,
      surface,
    });
    const layout = {
      kind: "split",
      nodeId: "00000000-0000-4000-8000-000000000633",
      orientation: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        nodeId: "00000000-0000-4000-8000-000000000634",
        orientation: "vertical",
        ratio: 0.5,
        first: pane(1, {
          kind: "code-overview",
          id: "00000000-0000-4000-8000-000000000636",
          threadId: threadA,
          mode: "code",
          title: "Overview",
        }),
        second: pane(2, {
          kind: "code-terminal",
          id: "00000000-0000-4000-8000-000000000637",
          threadId: threadA,
          mode: "code",
          title: "Terminal",
        }),
      },
      second: {
        kind: "split",
        nodeId: "00000000-0000-4000-8000-000000000639",
        orientation: "vertical",
        ratio: 0.5,
        first: pane(3, {
          kind: "apple-workbench",
          id: "00000000-0000-4000-8000-000000000638",
          threadId: threadB,
          mode: "code",
          title: "Apple workbench",
          projectPath: "Fixture.xcodeproj",
        }),
        second: pane(4, {
          kind: "code-diff",
          id: "00000000-0000-4000-8000-000000000641",
          threadId: threadB,
          mode: "code",
          title: "Changes",
          relativePath: "README.md",
        }),
      },
    } as never;

    expect(openLocalCodeThreadIds(layout).map(String)).toEqual([threadA, threadB]);
  });
});
