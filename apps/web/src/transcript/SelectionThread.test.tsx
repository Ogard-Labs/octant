import type { ProjectId } from "@octant/contracts/projects";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
