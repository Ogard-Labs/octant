import { decodeWorkspaceLayoutNode } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { activeCodeThreadTabId, openLocalCodeThreadIds } from "./workspaceTabLifecycle";

describe("workspace tab lifecycle", () => {
  /**
   * Split view: focusing the Browser pane must not unload the Code thread
   * shown in the sibling pane. A utility tab has no thread of its own, so the
   * visible Code thread stays active; a Welcome tab still yields none.
   */
  it("keeps the sibling pane's Code thread active while a utility tab is focused", () => {
    const threadId = "00000000-0000-4000-8000-000000000701";
    const browserGroupId = "00000000-0000-4000-8000-000000000622";
    const layout = (activeTabId: string) =>
      decodeWorkspaceLayoutNode({
        kind: "split",
        nodeId: "00000000-0000-4000-8000-000000000610",
        orientation: "horizontal",
        ratio: 0.5,
        first: {
          kind: "group",
          nodeId: "00000000-0000-4000-8000-000000000611",
          groupId: "00000000-0000-4000-8000-000000000612",
          tabs: [
            {
              kind: "code-overview",
              id: "00000000-0000-4000-8000-000000000613",
              threadId,
              mode: "code",
              title: "Thread",
            },
          ],
          activeTabId: "00000000-0000-4000-8000-000000000613",
        },
        second: {
          kind: "group",
          nodeId: "00000000-0000-4000-8000-000000000621",
          groupId: browserGroupId,
          tabs: [
            {
              kind: "browser",
              id: "00000000-0000-4000-8000-000000000623",
              mode: "code",
              title: "Browser",
            },
            {
              kind: "welcome",
              id: "00000000-0000-4000-8000-000000000624",
              mode: "code",
              title: "Welcome",
            },
          ],
          activeTabId,
        },
      });

    expect(
      activeCodeThreadTabId(
        layout("00000000-0000-4000-8000-000000000623"),
        browserGroupId as never,
      ),
    ).toBe(threadId);
    expect(
      activeCodeThreadTabId(
        layout("00000000-0000-4000-8000-000000000624"),
        browserGroupId as never,
      ),
    ).toBeUndefined();
  });

  it("collects every open Code thread once, however many surfaces it has open", () => {
    const threadA = "00000000-0000-4000-8000-000000000631";
    const threadB = "00000000-0000-4000-8000-000000000632";
    const layout = {
      kind: "split",
      nodeId: "00000000-0000-4000-8000-000000000633",
      orientation: "horizontal",
      ratio: 0.5,
      first: {
        kind: "group",
        nodeId: "00000000-0000-4000-8000-000000000634",
        groupId: "00000000-0000-4000-8000-000000000635",
        activeTabId: "00000000-0000-4000-8000-000000000636",
        tabs: [
          {
            kind: "code-overview",
            id: "00000000-0000-4000-8000-000000000636",
            threadId: threadA,
            mode: "code",
            title: "Overview",
          },
          {
            kind: "code-terminal",
            id: "00000000-0000-4000-8000-000000000637",
            threadId: threadA,
            mode: "code",
            title: "Terminal",
          },
          {
            kind: "apple-workbench",
            id: "00000000-0000-4000-8000-000000000638",
            threadId: threadB,
            mode: "code",
            title: "Apple workbench",
            projectPath: "Fixture.xcodeproj",
          },
        ],
      },
      second: {
        kind: "group",
        nodeId: "00000000-0000-4000-8000-000000000639",
        groupId: "00000000-0000-4000-8000-000000000640",
        activeTabId: "00000000-0000-4000-8000-000000000641",
        tabs: [
          {
            kind: "code-diff",
            id: "00000000-0000-4000-8000-000000000641",
            threadId: threadB,
            mode: "code",
            title: "Changes",
            relativePath: "README.md",
          },
          {
            kind: "browser",
            id: "00000000-0000-4000-8000-000000000642",
            mode: "code",
            title: "Browser",
          },
        ],
      },
    } as never;

    expect(openLocalCodeThreadIds(layout).map(String)).toEqual([threadA, threadB]);
  });
});
