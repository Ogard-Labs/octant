import { describe, expect, it } from "vitest";
import { trafficSankeyExample } from "./canvasChartExamples";
import { layoutCanvasSankey, sankeyNodeLabels } from "./canvasSankeyLayout";

describe("sankey layout", () => {
  const links = trafficSankeyExample.links;

  it("lists nodes in the order the flows first name them", () => {
    expect(sankeyNodeLabels(links)).toEqual([
      "Search",
      "Docs",
      "Pricing",
      "Social",
      "Blog",
      "Trial",
      "Left",
    ]);
  });

  it("places sources left, each node right of what feeds it, and every ending in the last column", () => {
    const layout = layoutCanvasSankey(links, { width: 400, height: 200 });
    const column = new Map(layout.nodes.map((node) => [node.label, node.column]));
    expect(layout.columns).toBe(3);
    expect(column.get("Search")).toBe(0);
    expect(column.get("Social")).toBe(0);
    expect(column.get("Docs")).toBe(1);
    expect(column.get("Pricing")).toBe(1);
    expect(column.get("Trial")).toBe(2);
    expect(column.get("Left")).toBe(2);
    const right = layout.nodes.find((node) => node.label === "Left");
    expect((right?.x ?? 0) + (right?.width ?? 0)).toBeCloseTo(400);
  });

  it("draws every band at one scale, so a flow keeps its width and fits the height", () => {
    const layout = layoutCanvasSankey(links, { width: 400, height: 200 });
    const perUnit = layout.links.map((link) => link.thickness / link.value);
    for (const ratio of perUnit) expect(ratio).toBeCloseTo(perUnit[0] ?? 0);
    for (const node of layout.nodes) {
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y + node.height).toBeLessThanOrEqual(200.0001);
      expect(node.height).toBeCloseTo(Math.max(node.inflow, node.outflow) * (perUnit[0] ?? 0));
    }
  });

  it("lays out a loop in a final column instead of spinning", () => {
    const layout = layoutCanvasSankey(
      [
        { source: "A", target: "B", value: 1 },
        { source: "B", target: "A", value: 1 },
      ],
      { width: 100, height: 50 },
    );
    expect(layout.nodes).toHaveLength(2);
  });
});
