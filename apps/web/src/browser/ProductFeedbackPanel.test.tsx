import {
  decodeProductFeedbackNote,
  decodeProductFeedbackPreview,
} from "@octant/contracts/product-feedback";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductFeedbackPanel } from "./ProductFeedbackPanel";

const now = "2026-08-18T09:00:00.000Z";

const note = decodeProductFeedbackNote({
  id: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  mode: "code",
  comment: "This button is off by a few pixels.",
  element: {
    kind: "browser-element",
    selector: "main > button:nth-of-type(2)",
    accessibleName: "Save changes",
    bounds: { x: 0.25, y: 0.5, width: 0.1, height: 0.05 },
  },
  provenance: {
    comment: { origin: "user", sourceLabel: "product-feedback-comment" },
    element: { origin: "external-content", sourceLabel: "browser-page" },
  },
  lifecycle: "pending",
  capturedAt: now,
  version: 1,
  updatedAt: now,
});

const preview = () =>
  decodeProductFeedbackPreview({
    id: "33333333-3333-4333-8333-333333333333",
    threadId: note.threadId,
    mode: "code",
    element: note.element,
    provenance: note.provenance,
    capturedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

function panel(overrides: Partial<Parameters<typeof ProductFeedbackPanel>[0]> = {}) {
  const onSubmit = vi
    .fn<Parameters<typeof ProductFeedbackPanel>[0]["onSubmit"]>()
    .mockResolvedValue(true);
  const onCancel = vi.fn();
  const onDiscard = vi.fn();
  const onTogglePointing = vi.fn();
  const onUpdate = vi
    .fn<Parameters<typeof ProductFeedbackPanel>[0]["onUpdate"]>()
    .mockResolvedValue(true);
  const onRefresh = vi.fn();
  const view = render(
    <ProductFeedbackPanel
      busy={false}
      onCancel={onCancel}
      onDiscard={onDiscard}
      onSubmit={onSubmit}
      onTogglePointing={onTogglePointing}
      pending={[]}
      crops={{}}
      preview={undefined}
      previewExpired={false}
      onUpdate={onUpdate}
      onRefresh={onRefresh}
      pointing={false}
      {...overrides}
    />,
  );
  return { onSubmit, onCancel, onDiscard, onTogglePointing, onUpdate, onRefresh, view };
}

describe("pointing at the running product", () => {
  it("asks the user to tap the thing they mean once pointing is on", () => {
    panel({ pointing: true });

    expect(screen.getByRole("button", { name: "Cancel pointing" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Tap the thing you mean");
  });

  it("writes a note about the spot the user marked", async () => {
    const user = userEvent.setup();
    const { onSubmit } = panel({ preview: preview() });

    await user.type(screen.getByRole("textbox", { name: "What is wrong with this?" }), "Too dark.");
    await user.click(screen.getByRole("button", { name: "Leave the note" }));

    expect(onSubmit).toHaveBeenCalledWith("Too dark.");
  });

  it("refuses to send an empty note", () => {
    panel({ preview: preview() });

    expect(screen.getByRole("button", { name: "Leave the note" })).toBeDisabled();
  });

  it("says the notes travel with the next message", () => {
    panel({ pending: [note] });

    expect(screen.getByText("1 note goes with your next message")).toBeInTheDocument();
    // The element is named the way a person would recognise it, not by selector.
    expect(screen.getByRole("heading", { name: "Save changes" })).toBeVisible();
  });

  it("removes a note the user changed their mind about", async () => {
    const user = userEvent.setup();
    const { onDiscard } = panel({ pending: [note] });

    await user.click(
      screen.getByRole("button", { name: "Remove note: This button is off by a few pixels." }),
    );

    expect(onDiscard).toHaveBeenCalledWith(note);
  });

  it("reports the host's refusal where the user is looking", () => {
    panel({ message: "There is nothing at that spot to point at." });

    expect(screen.getByRole("status")).toHaveTextContent("There is nothing at that spot");
  });
  it("keeps the comment after a refused save and an explicit recapture", async () => {
    const onSubmit = vi
      .fn<Parameters<typeof ProductFeedbackPanel>[0]["onSubmit"]>()
      .mockResolvedValue(false);
    const initial = preview();
    const props = {
      busy: false,
      pending: [],
      crops: {},
      preview: initial,
      previewExpired: false,
      pointing: false,
      onSubmit,
      onCancel: vi.fn(),
      onDiscard: vi.fn(),
      onTogglePointing: vi.fn(),
      onUpdate: vi.fn().mockResolvedValue(true),
      onRefresh: vi.fn(),
    };
    const view = render(<ProductFeedbackPanel {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "What is wrong with this?" }), {
      target: { value: "Keep my wording" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Leave the note" }));
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      <ProductFeedbackPanel
        {...props}
        preview={decodeProductFeedbackPreview({
          ...initial,
          id: "44444444-4444-4444-8444-444444444444",
          element: { ...initial.element, selector: "button.new" },
        })}
      />,
    );
    expect(screen.getByRole("textbox", { name: "What is wrong with this?" })).toHaveValue(
      "Keep my wording",
    );
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Keep my wording");
  });

  it("preserves newer in-memory text and caret when an earlier save finishes", async () => {
    let release: (saved: boolean) => void = () => undefined;
    const onSubmit = vi.fn<Parameters<typeof ProductFeedbackPanel>[0]["onSubmit"]>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    panel({ preview: preview(), onSubmit });
    const input = screen.getByRole("textbox", { name: "What is wrong with this?" });
    if (!(input instanceof HTMLTextAreaElement)) throw Error("Missing comment input");
    fireEvent.change(input, { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Leave the note" }));
    fireEvent.change(input, { target: { value: "AB" } });
    input.setSelectionRange(1, 1);
    await act(async () => {
      release(true);
      await Promise.resolve();
    });
    expect(input).toHaveValue("AB");
    expect(input.selectionStart).toBe(1);
  });

  it("keeps an unsaved amendment through inclusion changes and uses the latest note version", async () => {
    const onUpdate = vi
      .fn<Parameters<typeof ProductFeedbackPanel>[0]["onUpdate"]>()
      .mockResolvedValue(true);
    const props = {
      busy: false,
      pending: [note],
      crops: {},
      preview: undefined,
      previewExpired: false,
      pointing: false,
      onSubmit: vi.fn().mockResolvedValue(true),
      onCancel: vi.fn(),
      onDiscard: vi.fn(),
      onTogglePointing: vi.fn(),
      onUpdate,
      onRefresh: vi.fn(),
    };
    const view = render(<ProductFeedbackPanel {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: `Edit note: ${note.comment}` }), {
      target: { value: "My amended comment" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: `Include note: ${note.comment}` }));
    expect(onUpdate).toHaveBeenCalledWith(note, { included: false });
    const selected = decodeProductFeedbackNote({ ...note, version: 2, included: false });
    view.rerender(<ProductFeedbackPanel {...props} pending={[selected]} />);
    expect(screen.getByRole("textbox", { name: `Edit note: ${note.comment}` })).toHaveValue(
      "My amended comment",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    expect(onUpdate).toHaveBeenLastCalledWith(selected, { comment: "My amended comment" });
  });
});
