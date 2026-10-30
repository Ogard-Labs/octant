import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createNewTaskDrafts,
  discardNewTaskDraftForOverview,
  discardNewTaskDraftForPane,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
  paneDraftsToDiscard,
  projectOverviewDraftsToDiscard,
  useNewTaskPrompt,
} from "./useNewTaskPrompt";

function PromptBox() {
  const [prompt, setPrompt] = useNewTaskPrompt();
  return (
    <textarea
      aria-label="Draft prompt"
      onChange={(event) => setPrompt(event.target.value)}
      value={prompt}
    />
  );
}

describe("useNewTaskPrompt", () => {
  it("shows the stored prompt for the current draft scope when the scope changes", () => {
    const drafts = createNewTaskDrafts();
    drafts.write("work-overview:a", "Alpha draft");
    drafts.write("work-overview:b", "Beta draft");
    function view(scope: string) {
      return (
        <NewTaskDraftsContext.Provider value={drafts}>
          <NewTaskDraftScopeContext.Provider value={scope}>
            <PromptBox />
          </NewTaskDraftScopeContext.Provider>
        </NewTaskDraftsContext.Provider>
      );
    }

    const rendered = render(view("work-overview:a"));
    expect(screen.getByRole("textbox", { name: "Draft prompt" })).toHaveValue("Alpha draft");
    rendered.rerender(view("work-overview:b"));
    expect(screen.getByRole("textbox", { name: "Draft prompt" })).toHaveValue("Beta draft");
  });

  it("clears the live prompt when the stored draft for this scope is emptied", () => {
    const drafts = createNewTaskDrafts();
    render(
      <NewTaskDraftsContext.Provider value={drafts}>
        <NewTaskDraftScopeContext.Provider value="chat-welcome:pane">
          <PromptBox />
        </NewTaskDraftScopeContext.Provider>
      </NewTaskDraftsContext.Provider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Draft prompt" }), {
      target: { value: "Start a chat" },
    });
    expect(screen.getByRole("textbox", { name: "Draft prompt" })).toHaveValue("Start a chat");

    act(() => {
      drafts.write("chat-welcome:pane", "");
    });
    expect(screen.getByRole("textbox", { name: "Draft prompt" })).toHaveValue("");
  });

  it("discards only the named pane's persisted prompt and images", () => {
    const drafts = createNewTaskDrafts();
    drafts.write("chat:pane-a", "Submitted from A");
    drafts.write("chat-welcome:pane-a", "Welcome A");
    drafts.writeImages("chat:pane-a", [
      new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
    ]);
    drafts.write("chat:pane-b", "Unsent in B");
    drafts.write("chat-welcome:pane-b", "Welcome B");
    drafts.writeImages("chat:pane-b", [
      new File([new Uint8Array([2])], "b.png", { type: "image/png" }),
    ]);
    drafts.writeCreateFrom("chat:pane-a", {
      kind: "linear",
      request: { id: "11111111-1111-4111-8111-111111111111" as never },
      label: "ENG-12",
    });
    drafts.writeCreateFrom("chat:pane-b", {
      kind: "linear",
      request: { id: "22222222-2222-4222-8222-222222222222" as never },
      label: "ENG-13",
    });
    drafts.writeMentionChips("chat:pane-a", [
      {
        threadId: "00000000-0000-4000-8000-000000000101",
        title: "Prior A",
        mode: "chat",
        placementLabel: "Recents",
      },
    ]);
    drafts.writeMentionChips("chat:pane-b", [
      {
        threadId: "00000000-0000-4000-8000-000000000102",
        title: "Prior B",
        mode: "chat",
        placementLabel: "Recents",
      },
    ]);
    drafts.writeExtensionReceipts("chat:pane-a", [
      {
        reference: "$review",
        label: "Review",
        status: { kind: "blocked", reason: "unavailable" },
      },
    ]);
    drafts.writeCodeCheckout("code:pane-a", {
      baseBranch: "fix/a",
      baseBranchChosen: true,
    });

    discardNewTaskDraftForPane(drafts, "chat", "pane-a");

    expect(drafts.read("chat:pane-a")).toBe("");
    expect(drafts.read("chat-welcome:pane-a")).toBe("");
    expect(drafts.readImages("chat:pane-a")).toEqual([]);
    expect(drafts.readCreateFrom("chat:pane-a")).toBeUndefined();
    expect(drafts.readMentionChips("chat:pane-a")).toEqual([]);
    expect(drafts.readExtensionReceipts("chat:pane-a")).toEqual([]);
    expect(drafts.read("chat:pane-b")).toBe("Unsent in B");
    expect(drafts.read("chat-welcome:pane-b")).toBe("Welcome B");
    expect(drafts.readImages("chat:pane-b")).toHaveLength(1);
    expect(drafts.readCreateFrom("chat:pane-b")?.label).toBe("ENG-13");
    expect(drafts.readMentionChips("chat:pane-b")[0]?.title).toBe("Prior B");
  });

  it("discards only the named Project overview draft", () => {
    const drafts = createNewTaskDrafts();
    drafts.write("work-overview:project-a", "Alpha task");
    drafts.writeImages("work-overview:project-a", [
      new File([new Uint8Array([1])], "alpha.png", { type: "image/png" }),
    ]);
    drafts.write("work-overview:project-b", "Beta task");
    drafts.writeImages("work-overview:project-b", [
      new File([new Uint8Array([2])], "beta.png", { type: "image/png" }),
    ]);
    drafts.write("chat-overview:project-a", "Chat notes");

    discardNewTaskDraftForOverview(drafts, "work", "project-a");

    expect(drafts.read("work-overview:project-a")).toBe("");
    expect(drafts.readImages("work-overview:project-a")).toEqual([]);
    expect(drafts.read("work-overview:project-b")).toBe("Beta task");
    expect(drafts.readImages("work-overview:project-b")).toHaveLength(1);
    expect(drafts.read("chat-overview:project-a")).toBe("Chat notes");
  });

  it("drops an overview draft only when that Project is no longer open", () => {
    expect(
      projectOverviewDraftsToDiscard(
        [
          { mode: "chat", projectId: "project-a" },
          { mode: "work", projectId: "project-b" },
        ],
        [{ mode: "work", projectId: "project-b" }],
        1,
        2,
      ),
    ).toEqual([{ mode: "chat", projectId: "project-a" }]);
    expect(
      projectOverviewDraftsToDiscard(
        [{ mode: "chat", projectId: "project-a" }],
        [
          { mode: "chat", projectId: "project-a" },
          { mode: "chat", projectId: "project-a" },
        ],
        1,
        2,
      ),
    ).toEqual([]);
    expect(
      projectOverviewDraftsToDiscard([], [{ mode: "chat", projectId: "project-a" }], 1, 2),
    ).toEqual([]);
  });

  it("keeps overview drafts across an uncommitted workspace change", () => {
    expect(
      projectOverviewDraftsToDiscard([{ mode: "chat", projectId: "project-a" }], [], 1, 1),
    ).toEqual([]);
    expect(
      projectOverviewDraftsToDiscard([{ mode: "chat", projectId: "project-a" }], [], 1),
    ).toEqual([]);
  });

  it("drops a pane draft only after that start surface is no longer open", () => {
    expect(
      paneDraftsToDiscard(
        [
          { mode: "code", paneId: "pane-a" },
          { mode: "chat", paneId: "pane-b" },
        ],
        [{ mode: "chat", paneId: "pane-b" }],
        1,
        2,
      ),
    ).toEqual([{ mode: "code", paneId: "pane-a" }]);
    expect(paneDraftsToDiscard([{ mode: "code", paneId: "pane-a" }], [], 1, 1)).toEqual([]);
  });
});
