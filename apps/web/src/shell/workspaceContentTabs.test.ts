import {
  decodeWorkspaceOperation,
  decodeWorkspaceTab,
  type WindowWorkspace,
} from "@octant/contracts";
import { applyWorkspaceOperation } from "@octant/domain/shell-policy";
import { describe, expect, it } from "vitest";
import { chatShellBootstrap } from "../App.test-fixtures";
import { rememberWorkspaceContent, settleThreadPreview } from "./workspaceContentTabs";
import { encodeWorkspaceContent, decodeWorkspaceContent } from "./workspaceContentPersistence";

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
function tabsAfter(opens: ReadonlyArray<number>) {
  let workspace = chatShellBootstrap().workspace;
  let tabs: ReturnType<typeof rememberWorkspaceContent> = new Map();
  for (const index of opens) {
    const next = open(workspace, index);
    tabs = rememberWorkspaceContent(tabs, workspace, next);
    workspace = next;
  }
  return [...tabs.values()].flat().map((tab) => tab.title);
}

describe("what a pane keeps in its row", () => {
  it("restores a kept reference only in the same authority context and omits a temporary preview", () => {
    const first = open(chatShellBootstrap().workspace, 0);
    const second = open(first, 1);
    const tabs = rememberWorkspaceContent(
      rememberWorkspaceContent(new Map(), first, first),
      first,
      second,
    );
    const kept = encodeWorkspaceContent(second, tabs, new Set());
    expect(
      [...decodeWorkspaceContent(kept, second).values()].flat().map((tab) => tab.title),
    ).toEqual(["Thread 1"]);
    const previewed = encodeWorkspaceContent(second, tabs, new Set([THREADS[1]]));
    expect([...decodeWorkspaceContent(previewed, second).values()].flat()).toEqual([]);
    const moved = {
      ...second,
      contextByMode: {
        ...second.contextByMode,
        chat: { ...second.contextByMode.chat, boundRoot: "/another/root" },
      },
    };
    expect([...decodeWorkspaceContent(kept, moved).values()].flat()).toEqual([]);
    expect([...decodeWorkspaceContent("invalid", second).values()]).toEqual([]);
    expect(
      [
        ...decodeWorkspaceContent(
          encodeWorkspaceContent(second, new Map(), new Set()),
          second,
        ).values(),
      ].flat(),
    ).toEqual([]);
    expect(second.layouts.chat).toEqual(open(first, 1).layouts.chat);
  });

  it("keeps one conversation: the thread the pane shows and no other", () => {
    expect(tabsAfter([0, 1, 2])).toEqual(["Thread 2"]);
    expect(tabsAfter([0, 1, 0])).toEqual(["Thread 0"]);
  });

  it("keeps the conversation in the row when a canvas opens over it", () => {
    const first = open(chatShellBootstrap().workspace, 0);
    const pane = first.layouts.chat;
    if (pane.kind !== "pane") throw new Error("Expected one Chat pane.");
    const withCanvas = applyWorkspaceOperation(
      first,
      decodeWorkspaceOperation({
        kind: "open-surface",
        mode: "chat",
        paneId: String(pane.paneId),
        surface: {
          kind: "canvas",
          id: "00000000-0000-4000-8000-000000000930",
          mode: "chat",
          title: "Plan",
          canvasId: "00000000-0000-4000-8000-000000000931",
          projectId: null,
        },
      }),
    );
    const row = rememberWorkspaceContent(
      rememberWorkspaceContent(new Map(), first, first),
      first,
      withCanvas,
    );
    expect([...row.values()].flat().map((tab) => tab.title)).toEqual(["Thread 0", "Plan"]);
  });

  it("keeps the conversation in the row when a pull request the thread worked on opens over it", () => {
    const base = chatShellBootstrap().workspace;
    const codePane = base.layouts.code;
    if (codePane.kind !== "pane") throw new Error("Expected one Code pane.");
    const threadId = "00000000-0000-4000-8000-000000000940";
    const surface = (kind: "code-overview" | "code-pr", id: string, title: string) =>
      decodeWorkspaceTab({
        kind,
        id,
        mode: "code",
        threadId,
        title,
        ...(kind === "code-pr"
          ? {
              pullRequest: {
                projectId: "00000000-0000-4000-8000-000000000941",
                repositoryOwner: "acme",
                repositoryName: "app",
                number: 917,
              },
            }
          : {}),
      });
    const openSurface = (workspace: WindowWorkspace, tab: ReturnType<typeof surface>) =>
      applyWorkspaceOperation(
        workspace,
        decodeWorkspaceOperation({
          kind: "open-surface",
          mode: "code",
          paneId: String(codePane.paneId),
          surface: tab,
        }),
      );
    const conversation = openSurface(
      base,
      surface("code-overview", "00000000-0000-4000-8000-000000000942", "Fix flakes"),
    );
    const withPullRequest = openSurface(
      conversation,
      surface("code-pr", "00000000-0000-4000-8000-000000000943", "#917"),
    );
    const row = rememberWorkspaceContent(
      rememberWorkspaceContent(new Map(), conversation, conversation),
      conversation,
      withPullRequest,
    );
    expect(row.get(codePane.paneId)?.map((tab) => tab.title)).toEqual(["Fix flakes", "#917"]);
  });

  it("keeps a canvas beside the conversation, where it stood, when another thread opens", () => {
    const first = open(chatShellBootstrap().workspace, 0);
    const pane = first.layouts.chat;
    if (pane.kind !== "pane") throw new Error("Expected one Chat pane.");
    const canvas = decodeWorkspaceTab({
      kind: "canvas",
      id: "00000000-0000-4000-8000-000000000920",
      mode: "chat",
      title: "Plan",
      canvasId: "00000000-0000-4000-8000-000000000921",
      projectId: null,
    });
    const row = new Map([[pane.paneId, [pane.surface, canvas]]]);
    const second = open(first, 1);
    expect(
      [...rememberWorkspaceContent(row, first, second).values()].flat().map((tab) => tab.title),
    ).toEqual(["Thread 1", "Plan"]);
  });

  it("prunes a restored row that still holds several conversations", () => {
    const first = open(chatShellBootstrap().workspace, 0);
    const second = open(first, 1);
    const third = open(second, 2);
    const pane = third.layouts.chat;
    const earlier = [first, second].map((workspace) => {
      const layout = workspace.layouts.chat;
      if (layout.kind !== "pane") throw new Error("Expected one Chat pane.");
      return layout.surface;
    });
    if (pane.kind !== "pane") throw new Error("Expected one Chat pane.");
    const stored = new Map([[pane.paneId, [...earlier, pane.surface]]]);
    expect(
      [...rememberWorkspaceContent(stored, third, third).values()].flat().map((tab) => tab.title),
    ).toEqual(["Thread 2"]);
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
