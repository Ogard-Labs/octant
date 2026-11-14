import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadNote, ThreadNotesResult } from "@octant/contracts";
import {
  draftWithNote,
  ThreadNotesProvider,
  ThreadNotesRows,
  type ThreadNotesServices,
} from "./ThreadNotes";

const threadId = "00000000-0000-4000-8000-000000000020";

function note(id: string, text: string): ThreadNote {
  return {
    id,
    text,
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
  } as ThreadNote;
}

function notesResult(notes: ReadonlyArray<ThreadNote>): ThreadNotesResult {
  return { kind: "thread-notes", threadId, notes } as ThreadNotesResult;
}

describe("Thread notes", () => {
  it("adds the person's note on the host and inserts a note only when asked", async () => {
    const kept = note("aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "Ask Dana about Q3");
    const services: ThreadNotesServices = {
      notes: vi.fn(async () => notesResult([kept])),
      add: vi.fn(async (_threadId: string, text: string) =>
        notesResult([kept, note("aaaaaaaa-aaaa-4aaa-8aaa-000000000002", text)]),
      ),
      edit: vi.fn(),
      remove: vi.fn(),
      recap: vi.fn(),
    };
    const onInsert = vi.fn();
    render(
      <ThreadNotesProvider services={services}>
        <ThreadNotesRows onInsert={onInsert} threadId={threadId} />
      </ThreadNotesProvider>,
    );

    expect(await screen.findByText("Ask Dana about Q3")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "New note" }), {
      target: { value: "  Draft is in /reports  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    await waitFor(() => expect(screen.getByText("Draft is in /reports")).toBeInTheDocument());
    expect(services.add).toHaveBeenCalledWith(threadId, "Draft is in /reports");
    expect(onInsert).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Insert in message" })[0] as HTMLElement);
    expect(onInsert).toHaveBeenCalledWith("Ask Dana about Q3");
    expect(draftWithNote("Please check  ", "Ask Dana about Q3")).toBe(
      "Please check\n\nAsk Dana about Q3",
    );
  });
});
