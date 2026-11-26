import type { ProjectId } from "@octant/contracts/projects";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ComposerInput, type ComposerInputElement } from "../composer/ComposerInput";
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
  it("offers a new thread from the selected reply text in the same Project and mode", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "New thread from selection" }));

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

  it("a Work reply selection adds a quote chip to this thread's composer", async () => {
    function WorkThread() {
      const [draft, setDraft] = useState("");
      return (
        <SelectionThreadScope
          mode="work"
          onAddToChat={(text) =>
            setDraft((current) =>
              appendComposerQuote(current, { source: REPLY_QUOTE_SOURCE, text, comment: "" }),
            )
          }
          projectId={projectId}
        >
          <SelectionThreadSurface>
            <p>The plan is to split the module.</p>
          </SelectionThreadSurface>
          <label htmlFor="work-prompt">Message</label>
          <ComposerInput
            id="work-prompt"
            onChange={(event) => setDraft(event.currentTarget.value)}
            value={draft}
          />
        </SelectionThreadScope>
      );
    }
    render(<WorkThread />);
    selectAll();
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));

    expect(
      await screen.findByRole("button", {
        name: `Quote from ${REPLY_QUOTE_SOURCE}: The plan is to split the module.`,
      }),
    ).toBeInTheDocument();
    const prompt = screen.getByRole<ComposerInputElement>("textbox", { name: "Message" });
    expect(findComposerQuotes(prompt.value)).toHaveLength(1);
  });
});
