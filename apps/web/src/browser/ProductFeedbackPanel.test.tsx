import { decodeProductFeedbackNote } from "@octant/contracts/product-feedback";
import { render, screen } from "@testing-library/react";
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

function panel(overrides: Partial<Parameters<typeof ProductFeedbackPanel>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const onDiscard = vi.fn();
  const onTogglePointing = vi.fn();
  render(
    <ProductFeedbackPanel
      busy={false}
      onCancel={onCancel}
      onDiscard={onDiscard}
      onSubmit={onSubmit}
      onTogglePointing={onTogglePointing}
      pending={[]}
      pointing={false}
      {...overrides}
    />,
  );
  return { onSubmit, onCancel, onDiscard, onTogglePointing };
}

describe("pointing at the running product", () => {
  it("asks the user to tap the thing they mean once pointing is on", () => {
    panel({ pointing: true });

    expect(screen.getByRole("button", { name: "Tap the thing you mean" })).toBeInTheDocument();
  });

  it("writes a note about the spot the user marked", async () => {
    const user = userEvent.setup();
    const { onSubmit } = panel({ pointing: true, pendingPoint: { x: 0.5, y: 0.5 } });

    await user.type(screen.getByRole("textbox", { name: "What is wrong with this?" }), "Too dark.");
    await user.click(screen.getByRole("button", { name: "Leave the note" }));

    expect(onSubmit).toHaveBeenCalledWith("Too dark.");
  });

  it("refuses to send an empty note", () => {
    panel({ pointing: true, pendingPoint: { x: 0.5, y: 0.5 } });

    expect(screen.getByRole("button", { name: "Leave the note" })).toBeDisabled();
  });

  it("says the notes travel with the next message", () => {
    panel({ pending: [note] });

    expect(screen.getByText("1 note goes with your next message")).toBeInTheDocument();
    // The element is named the way a person would recognise it, not by selector.
    expect(screen.getByText("Save changes")).toBeInTheDocument();
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
});
