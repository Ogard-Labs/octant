import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createNewTaskDrafts,
  discardNewTaskDraftForOverview,
  discardNewTaskDraftForPane,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
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

    discardNewTaskDraftForPane(drafts, "chat", "pane-a");

    expect(drafts.read("chat:pane-a")).toBe("");
    expect(drafts.read("chat-welcome:pane-a")).toBe("");
    expect(drafts.readImages("chat:pane-a")).toEqual([]);
    expect(drafts.read("chat:pane-b")).toBe("Unsent in B");
    expect(drafts.read("chat-welcome:pane-b")).toBe("Welcome B");
    expect(drafts.readImages("chat:pane-b")).toHaveLength(1);
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
      ),
    ).toEqual([{ mode: "chat", projectId: "project-a" }]);
    expect(
      projectOverviewDraftsToDiscard(
        [{ mode: "chat", projectId: "project-a" }],
        [
          { mode: "chat", projectId: "project-a" },
          { mode: "chat", projectId: "project-a" },
        ],
      ),
    ).toEqual([]);
    expect(projectOverviewDraftsToDiscard([], [{ mode: "chat", projectId: "project-a" }])).toEqual(
      [],
    );
  });
});
