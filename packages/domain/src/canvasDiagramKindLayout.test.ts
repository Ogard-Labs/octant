import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutCanvasEr, layoutCanvasMindmap, layoutCanvasSwimlane } from "./canvasKindLayout";
import { orderSchemaBlock, releaseMindmapBlock, supportFlowBlock } from "./canvasDiagramExamples";

const snapshot = JSON.parse(
  readFileSync(new URL("./canvasDiagramKindLayout.snapshot.json", import.meta.url), "utf8"),
) as {
  readonly er: ReturnType<typeof layoutCanvasEr>;
  readonly swimlane: ReturnType<typeof layoutCanvasSwimlane>;
  readonly mindmap: ReturnType<typeof layoutCanvasMindmap>;
};

describe("entity-relationship, swimlane, and mind map layout", () => {
  it("lays an entity-relationship model out the same way every time", () => {
    const layout = layoutCanvasEr(orderSchemaBlock);

    expect(layout).toEqual(snapshot.er);
    expect(layoutCanvasEr(orderSchemaBlock)).toEqual(layout);
    const byId = new Map(layout.entities.map((entity) => [entity.entityId, entity]));
    const person = byId.get("person");
    const order = byId.get("order");
    const payment = byId.get("payment");
    expect(person?.attributes).toHaveLength(2);
    expect(order?.attributes[0]?.key).toBe(true);
    // Three entities over a two-column grid: the third starts a new row below
    // the first column.
    expect(person?.y).toBe(order?.y);
    expect(payment?.y).toBeGreaterThan(order?.y ?? 0);
    const [places] = layout.relationships;
    expect(places?.sourceCardinality).toBe("one");
    expect(places?.targetCardinality).toBe("many");
    expect(places?.label).toBe("places");
  });

  it("keeps a relationship's label and both cardinalities apart from one another", () => {
    const layout = layoutCanvasEr(orderSchemaBlock);
    const places = layout.relationships.find((entry) => entry.label === "places");
    if (places === undefined) throw new Error("The places relationship was not routed.");
    const [start, end] = places.points;
    if (start === undefined || end === undefined) throw new Error("The line has no ends.");
    // Person sits left of Order, so the line runs across: the label rides above
    // it and each cardinality below it, reading away from the entity it names.
    const lineY = Math.max(start.y, end.y);
    expect(places.labelY).toBeLessThan(Math.min(start.y, end.y));
    expect(places.sourceCardinalityAt.y).toBeGreaterThan(lineY);
    expect(places.targetCardinalityAt.y).toBeGreaterThan(lineY);
    expect(places.sourceCardinalityAt.anchor).toBe("start");
    expect(places.targetCardinalityAt.anchor).toBe("end");
    // The longest cardinality is eleven characters; at the extra-small size a
    // character averages under 6px, so even two of the longest leave a space.
    const longest = 11 * 6;
    expect(places.sourceCardinalityAt.x + longest).toBeLessThan(
      places.targetCardinalityAt.x - longest,
    );
  });

  it("stacks swimlane lanes in order and lays each lane's steps left to right", () => {
    const layout = layoutCanvasSwimlane(supportFlowBlock);

    expect(layout).toEqual(snapshot.swimlane);
    expect(layoutCanvasSwimlane(supportFlowBlock)).toEqual(layout);
    const [customer, support, engineering] = layout.lanes;
    expect(customer?.label).toBe("Customer");
    expect(support?.y ?? 0).toBeGreaterThan(customer?.y ?? 0);
    expect(engineering?.y ?? 0).toBeGreaterThan(support?.y ?? 0);
    const report = layout.steps.find((step) => step.stepId === "report");
    const answer = layout.steps.find((step) => step.stepId === "answer");
    expect(report?.x).toBeLessThan(answer?.x ?? 0);
    expect(layout.steps.find((step) => step.stepId === "triage")?.decision).toBe(true);
    expect(layout.connections).toHaveLength(5);
  });

  it("starts each lane's first step clear of the lane's header divider", () => {
    const layout = layoutCanvasSwimlane(supportFlowBlock);
    for (const lane of layout.lanes) {
      const first = layout.steps.find((step) => step.laneId === lane.laneId);
      if (first === undefined) continue;
      expect(first.x).toBeGreaterThan(lane.x + lane.headerWidth);
      const last = layout.steps.filter((step) => step.laneId === lane.laneId).at(-1);
      expect((last?.x ?? 0) + (last?.width ?? 0)).toBeLessThan(lane.x + lane.width);
    }
  });

  it("draws a mind map as one root with each generation a column to the right", () => {
    const layout = layoutCanvasMindmap(releaseMindmapBlock);

    expect(layout).toEqual(snapshot.mindmap);
    expect(layoutCanvasMindmap(releaseMindmapBlock)).toEqual(layout);
    const root = layout.nodes.find((node) => node.root);
    const docs = layout.nodes.find((node) => node.nodeId === "docs");
    const architecture = layout.nodes.find((node) => node.nodeId === "architecture");
    expect(root?.depth).toBe(0);
    expect(root?.x).toBeLessThan(docs?.x ?? 0);
    expect(docs?.x).toBeLessThan(architecture?.x ?? 0);
    // A note makes its topic taller so the remark has room without overlap.
    const tests = layout.nodes.find((node) => node.nodeId === "tests");
    expect(tests?.height).toBeGreaterThan(docs?.height ?? 0);
    expect(layout.edges).toHaveLength(releaseMindmapBlock.nodes.length - 1);
  });
});
