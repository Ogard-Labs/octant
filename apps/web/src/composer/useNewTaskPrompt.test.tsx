import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createNewTaskDrafts,
  NewTaskDraftsContext,
  NewTaskDraftScopeContext,
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
});
