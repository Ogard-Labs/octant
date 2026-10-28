import { decodeUtcTimestamp } from "@octant/contracts/events";
import { describe, expect, it } from "vitest";
import {
  applyCanvasTagEvent,
  admitCanvasTagCommand,
  EMPTY_CANVAS_TAG_STATE,
} from "./canvasTagsPolicy";

const canvasId = "11111111-1111-4111-8111-111111111111" as never;
const now = decodeUtcTimestamp("2026-08-18T09:00:00.000Z");

function add(tag: string) {
  return { kind: "canvas-tag-add", canvasId, tag, issuedAt: now };
}

function remove(tag: string) {
  return { kind: "canvas-tag-remove", canvasId, tag, issuedAt: now };
}

describe("admitting a tag command", () => {
  it("accepts a tag a Canvas does not carry, at the next sequence", () => {
    const admitted = admitCanvasTagCommand(add("Launch"), EMPTY_CANVAS_TAG_STATE);

    expect(admitted).toEqual({
      kind: "accepted",
      event: { canvasId, tag: "Launch", addedAt: now, sequence: 1 },
    });
  });

  it("refuses a tag the Canvas already carries, without spending a sequence", () => {
    const held = applyCanvasTagEvent(EMPTY_CANVAS_TAG_STATE, {
      kind: "added",
      event: { canvasId, tag: "Launch", addedAt: now, sequence: 1 },
    });

    const admitted = admitCanvasTagCommand(add("Launch"), held);

    expect(admitted).toEqual({
      kind: "rejected",
      code: "duplicate-tag",
      message: "Canvas already carries this tag.",
    });
  });

  it("refuses a thirteenth tag and an over-long one", () => {
    let state = EMPTY_CANVAS_TAG_STATE;
    for (let index = 0; index < 12; index += 1) {
      const admitted = admitCanvasTagCommand(add(`tag-${index}`), state);
      if (admitted.kind !== "accepted") throw new Error("fixture tag was refused");
      state = applyCanvasTagEvent(state, {
        kind: "added",
        event: "addedAt" in admitted.event ? admitted.event : { ...admitted.event, addedAt: now },
      });
    }

    const over = admitCanvasTagCommand(add("one-too-many"), state);
    expect(over).toMatchObject({ kind: "rejected", code: "tag-budget-exceeded" });

    const long = admitCanvasTagCommand(add("x".repeat(41)), state);
    expect(long).toMatchObject({ kind: "rejected", code: "malformed-request" });
  });

  it("refuses removing a tag the Canvas does not carry", () => {
    const admitted = admitCanvasTagCommand(remove("Absent"), EMPTY_CANVAS_TAG_STATE);

    expect(admitted).toEqual({
      kind: "rejected",
      code: "unknown-tag",
      message: "Canvas does not carry this tag.",
    });
  });

  it("refuses a command that is not one", () => {
    expect(admitCanvasTagCommand({ kind: "canvas-tag-rename" }, EMPTY_CANVAS_TAG_STATE)).toEqual({
      kind: "rejected",
      code: "malformed-request",
      message: "Canvas tag command is malformed.",
    });
  });
});

describe("folding journaled tag facts", () => {
  it("adds a tag, removes one, and keeps the sequence each fact brought", () => {
    const added = applyCanvasTagEvent(EMPTY_CANVAS_TAG_STATE, {
      kind: "added",
      event: { canvasId, tag: "Launch", addedAt: now, sequence: 1 },
    });
    expect(added).toEqual({ tags: ["Launch"], sequence: 1 });

    const also = applyCanvasTagEvent(added, {
      kind: "added",
      event: { canvasId, tag: "Q4", addedAt: now, sequence: 2 },
    });
    expect(also).toEqual({ tags: ["Launch", "Q4"], sequence: 2 });

    const removed = applyCanvasTagEvent(also, {
      kind: "removed",
      event: { canvasId, tag: "Launch", removedAt: now, sequence: 3 },
    });
    expect(removed).toEqual({ tags: ["Q4"], sequence: 3 });
  });

  it("changes nothing but the sequence for a fact replayed twice", () => {
    const once = applyCanvasTagEvent(EMPTY_CANVAS_TAG_STATE, {
      kind: "added",
      event: { canvasId, tag: "Launch", addedAt: now, sequence: 1 },
    });
    const again = applyCanvasTagEvent(once, {
      kind: "added",
      event: { canvasId, tag: "Launch", addedAt: now, sequence: 2 },
    });

    expect(again).toEqual({ tags: ["Launch"], sequence: 2 });
  });
});
