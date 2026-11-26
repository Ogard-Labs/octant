import type { ProjectId } from "@octant/contracts/projects";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendComposerQuote,
  findComposerQuotes,
  REPLY_QUOTE_SOURCE,
} from "../composer/composerQuote";
import {
  SelectionThreadScope,
  SelectionThreadStarterContext,
  SelectionThreadSurface,
  selectionAsBlockQuote,
} from "./SelectionThread";

const projectId = "project-1" as ProjectId;

function selectAll(): void {
  const prose = screen.getByText("The plan is to split the module.");
  const range = document.createRange();
  range.selectNodeContents(prose);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe("selectionAsBlockQuote", () => {
  it("quotes every line, keeping blank lines inside the quote", () => {
    expect(selectionAsBlockQuote("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
  });
});

describe("SelectionThreadSurface", () => {
  it("offers a new thread from the selected reply text in the same Project and mode", () => {
    const start = vi.fn();
    render(
      <SelectionThreadStarterContext.Provider value={start}>
        <SelectionThreadScope mode="code" projectId={projectId}>
          <SelectionThreadSurface>
            <p>The plan is to split the module.</p>
          </SelectionThreadSurface>
        </SelectionThreadScope>
      </SelectionThreadStarterContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "New thread from selection" })).toBeNull();

    selectAll();
    fireEvent.click(screen.getByRole("button", { name: "New thread from selection" }));

    expect(start).toHaveBeenCalledWith({
      mode: "code",
      projectId,
      prompt: "> The plan is to split the module.\n\n",
    });
  });

  it("offers nothing outside a thread that can start one", () => {
    render(
      <SelectionThreadSurface>
        <p>The plan is to split the module.</p>
      </SelectionThreadSurface>,
    );
    selectAll();
    expect(screen.queryByRole("button", { name: "New thread from selection" })).toBeNull();
  });

  it("a Work reply selection adds a quote chip to this thread's composer", () => {
    const addToChat = vi.fn();
    render(
      <SelectionThreadScope mode="work" onAddToChat={addToChat} projectId={projectId}>
        <SelectionThreadSurface>
          <p>The plan is to split the module.</p>
        </SelectionThreadSurface>
      </SelectionThreadScope>,
    );
    selectAll();
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));

    expect(addToChat).toHaveBeenCalledWith({
      source: REPLY_QUOTE_SOURCE,
      text: "The plan is to split the module.",
      comment: "",
    });
    const draft = appendComposerQuote("", addToChat.mock.calls[0]?.[0]);
    expect(findComposerQuotes(draft)).toHaveLength(1);
  });
});
