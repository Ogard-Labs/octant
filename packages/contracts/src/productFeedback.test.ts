import { describe, expect, it } from "vitest";
import {
  MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH,
  PRODUCT_FEEDBACK_EVENT_NAMES,
  decodeProductFeedbackCommand,
  decodeProductFeedbackNote,
} from "./productFeedback";

const ids = {
  note: "11111111-1111-4111-8111-111111111111",
  thread: "22222222-2222-4222-8222-222222222222",
  context: "33333333-3333-4333-8333-333333333333",
  content: "44444444-4444-4444-8444-444444444444",
};

const now = "2026-08-18T09:00:00.000Z";

const note = {
  id: ids.note,
  threadId: ids.thread,
  mode: "code",
  comment: "This button is off by a few pixels.",
  element: {
    kind: "browser-element",
    selector: "main > form > button.primary",
    role: "button",
    accessibleName: "Save changes",
    url: "https://localhost:5173/settings",
    bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
  },
  crop: { contentId: ids.content, digest: "a".repeat(64), byteLength: 4_096 },
  provenance: {
    comment: { origin: "user", sourceLabel: "composer" },
    element: { origin: "external-content", sourceLabel: "browser-page" },
  },
  lifecycle: "pending",
  capturedAt: now,
  version: 1,
  updatedAt: now,
};

describe("a note pointed at the running product", () => {
  it("keeps the user's words and the page's identity apart", () => {
    const decoded = decodeProductFeedbackNote(note);
    expect(decoded.provenance.comment.origin).toBe("user");
    expect(decoded.provenance.element.origin).toBe("external-content");
  });

  it("refuses a note that claims delivery without saying when", () => {
    expect(() => decodeProductFeedbackNote({ ...note, lifecycle: "delivered" })).toThrow();
  });

  it("refuses a delivery time on a note nothing has carried", () => {
    expect(() => decodeProductFeedbackNote({ ...note, deliveredAt: now })).toThrow();
  });

  it("accepts a delivered note that says when it went", () => {
    const delivered = decodeProductFeedbackNote({
      ...note,
      lifecycle: "delivered",
      deliveredAt: now,
      version: 2,
    });
    expect(delivered.lifecycle).toBe("delivered");
  });

  it("carries a native accessibility identity for the surface this is coming to next", () => {
    const decoded = decodeProductFeedbackNote({
      ...note,
      element: {
        kind: "accessibility-element",
        identifier: "settings.save",
        role: "button",
        label: "Save changes",
        bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
      },
    });
    expect(decoded.element.kind).toBe("accessibility-element");
  });

  it("refuses a comment longer than a sentence about what is on screen", () => {
    expect(() =>
      decodeProductFeedbackNote({
        ...note,
        comment: "n".repeat(MAX_PRODUCT_FEEDBACK_COMMENT_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("takes a capture request that names where the user tapped, not what it found", () => {
    const command = decodeProductFeedbackCommand({
      kind: "capture-product-feedback",
      threadId: ids.thread,
      mode: "code",
      contextId: ids.context,
      point: { x: 0.5, y: 0.5 },
      comment: "Wrong colour.",
    });
    expect(command.kind).toBe("capture-product-feedback");
  });

  it("refuses a capture request that supplies its own element", () => {
    expect(() =>
      decodeProductFeedbackCommand({
        kind: "capture-product-feedback",
        threadId: ids.thread,
        mode: "code",
        contextId: ids.context,
        point: { x: 0.5, y: 0.5 },
        comment: "Wrong colour.",
        element: note.element,
      }),
    ).toThrow();
  });

  it("names every note event it journals", () => {
    expect([...PRODUCT_FEEDBACK_EVENT_NAMES]).toEqual([
      "feedback.note-captured@1",
      "feedback.note-discarded@1",
      "feedback.note-delivered@1",
    ]);
  });
});
