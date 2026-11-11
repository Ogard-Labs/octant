import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_LAYER_CARD_HEIGHT,
  AGENT_RUN_LAYER_CARD_WIDTH,
  AGENT_RUN_LAYER_MIN_CARD_WIDTH,
  layoutAgentRunLayers,
} from "./layoutAgentRunLayers";

function boxOf(layout: ReturnType<typeof layoutAgentRunLayers>, id: string) {
  const box = layout.boxes.find((candidate) => candidate.id === id);
  if (box === undefined) throw new Error(`No box for ${id}`);
  return box;
}

describe("layoutAgentRunLayers", () => {
  it("draws nothing for a thread with no runs", () => {
    expect(layoutAgentRunLayers([])).toEqual({ width: 0, height: 0, boxes: [], edges: [] });
  });

  it("places a run below every run it waits for, however far down that is", () => {
    const layout = layoutAgentRunLayers([
      { id: "tokens", after: [] },
      { id: "toggle", after: [] },
      { id: "styles", after: ["tokens", "toggle"] },
      { id: "verify", after: ["styles", "tokens"] },
    ]);

    expect(boxOf(layout, "tokens").layer).toBe(0);
    expect(boxOf(layout, "toggle").layer).toBe(0);
    expect(boxOf(layout, "styles").layer).toBe(1);
    expect(boxOf(layout, "verify").layer).toBe(2);
    expect(boxOf(layout, "styles").y).toBeGreaterThan(
      boxOf(layout, "tokens").y + AGENT_RUN_LAYER_CARD_HEIGHT,
    );
    expect(boxOf(layout, "verify").y).toBeGreaterThan(
      boxOf(layout, "styles").y + AGENT_RUN_LAYER_CARD_HEIGHT,
    );
  });

  it("draws one arrow per wait, from the bottom of the earlier run to the top of the later one", () => {
    const layout = layoutAgentRunLayers([
      { id: "tokens", after: [] },
      { id: "styles", after: ["tokens"] },
    ]);

    const tokens = boxOf(layout, "tokens");
    const styles = boxOf(layout, "styles");
    expect(layout.edges).toEqual([
      {
        fromId: "tokens",
        toId: "styles",
        kind: "after",
        x1: tokens.x + AGENT_RUN_LAYER_CARD_WIDTH / 2,
        y1: tokens.y + AGENT_RUN_LAYER_CARD_HEIGHT,
        x2: styles.x + AGENT_RUN_LAYER_CARD_WIDTH / 2,
        y2: styles.y,
      },
    ]);
  });

  it("places a run under the run that started it and marks that link apart from a wait", () => {
    const layout = layoutAgentRunLayers([
      { id: "lead", after: [] },
      { id: "helper", after: [], startedBy: "lead" },
    ]);

    expect(boxOf(layout, "helper").layer).toBe(1);
    expect(layout.edges.map((edge) => [edge.fromId, edge.toId, edge.kind])).toEqual([
      ["lead", "helper", "started"],
    ]);
  });

  it("keeps a row's runs in the order given and sorts the next row under what it waits for", () => {
    const layout = layoutAgentRunLayers([
      { id: "left", after: [] },
      { id: "right", after: [] },
      { id: "under-right", after: ["right"] },
      { id: "under-left", after: ["left"] },
    ]);

    expect(boxOf(layout, "left").x).toBeLessThan(boxOf(layout, "right").x);
    expect(boxOf(layout, "under-left").x).toBeLessThan(boxOf(layout, "under-right").x);
  });

  it("narrows the cards to keep a row inside the width it has, and no further than still reads", () => {
    const three = [
      { id: "a", after: [] },
      { id: "b", after: [] },
      { id: "c", after: [] },
    ];

    const roomy = layoutAgentRunLayers(three, { availableWidth: 900 });
    expect(boxOf(roomy, "a").width).toBe(AGENT_RUN_LAYER_CARD_WIDTH);

    const dock = layoutAgentRunLayers(three, { availableWidth: 390 });
    expect(dock.width).toBeLessThanOrEqual(390);
    expect(boxOf(dock, "a").width).toBeGreaterThanOrEqual(AGENT_RUN_LAYER_MIN_CARD_WIDTH);
    expect(boxOf(dock, "c").x + boxOf(dock, "c").width).toBeLessThanOrEqual(dock.width);

    // Too narrow for three readable cards: they stop shrinking and the row
    // overflows, which the surface scrolls.
    const cramped = layoutAgentRunLayers(three, { availableWidth: 280 });
    expect(boxOf(cramped, "a").width).toBe(AGENT_RUN_LAYER_MIN_CARD_WIDTH);
    expect(cramped.width).toBeGreaterThan(280);
  });

  it("ignores a wait on a run that is not listed, so a hidden run leaves no arrow or gap", () => {
    const layout = layoutAgentRunLayers([{ id: "styles", after: ["not-listed"] }]);

    expect(boxOf(layout, "styles").layer).toBe(0);
    expect(layout.edges).toEqual([]);
  });

  it("still places every run when the links loop back on themselves", () => {
    const layout = layoutAgentRunLayers([
      { id: "a", after: ["b"] },
      { id: "b", after: ["a"] },
      { id: "self", after: ["self"] },
    ]);

    expect(layout.boxes.map((box) => box.id).sort()).toEqual(["a", "b", "self"]);
    expect(layout.width).toBeGreaterThan(0);
    for (const box of layout.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
  });
});
