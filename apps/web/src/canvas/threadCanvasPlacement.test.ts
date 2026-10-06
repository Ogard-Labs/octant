import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { describe, expect, it } from "vitest";
import { placeInlineCanvases, threadTurnSpans } from "./threadCanvasPlacement";

interface Row {
  readonly key: string;
  readonly at?: string;
}

function card(
  canvasId: string,
  fields: Partial<Pick<CanvasThreadReferenceCard, "presentation" | "canvasCreatedAt">>,
): CanvasThreadReferenceCard {
  return { canvasId, ...fields } as unknown as CanvasThreadReferenceCard;
}

// Two turns: the person's message, then the agent's reply rows.
const rows: ReadonlyArray<Row> = [
  { key: "ask-1", at: "2026-10-06T09:00:00.000Z" },
  { key: "reply-1a" },
  { key: "reply-1b" },
  { key: "ask-2", at: "2026-10-06T09:10:00.000Z" },
  { key: "reply-2" },
];
const turns = threadTurnSpans(
  rows,
  (row) => row.key,
  (row) => row.at,
);

describe("placing inline Canvases in a transcript", () => {
  it("draws a Canvas after the last row of the turn that wrote it", () => {
    const placement = placeInlineCanvases(turns, [
      card("first", {
        presentation: "inline",
        canvasCreatedAt: "2026-10-06T09:02:00.000Z" as never,
      }),
      card("second", {
        presentation: "inline",
        canvasCreatedAt: "2026-10-06T09:11:00.000Z" as never,
      }),
    ]);

    expect(placement.byRow.get("reply-1b")?.map((entry) => String(entry.canvasId))).toEqual([
      "first",
    ]);
    expect(placement.byRow.get("reply-2")?.map((entry) => String(entry.canvasId))).toEqual([
      "second",
    ]);
    expect([...placement.placed]).toEqual(["first", "second"]);
  });

  it("leaves a sidebar Canvas, or one it cannot date, to the thread's card list", () => {
    const placement = placeInlineCanvases(turns, [
      card("sidebar", {
        presentation: "sidebar",
        canvasCreatedAt: "2026-10-06T09:02:00.000Z" as never,
      }),
      // An older host sends no creation time; the Canvas is still shown, as a card.
      card("undated", { presentation: "inline" }),
      // Written before any turn the transcript has loaded.
      card("early", {
        presentation: "inline",
        canvasCreatedAt: "2026-10-06T08:00:00.000Z" as never,
      }),
    ]);

    expect(placement.byRow.size).toBe(0);
    expect(placement.placed.size).toBe(0);
  });
});
