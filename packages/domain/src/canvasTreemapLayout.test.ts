import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repositoryMapBlock } from "./canvasTreemapExamples";
import {
  layoutCanvasTreemap,
  treemapMeasureDomain,
  treemapPath,
  treemapTotals,
} from "./canvasTreemapLayout";

const snapshot = JSON.parse(
  readFileSync(new URL("./canvasTreemapLayout.snapshot.json", import.meta.url), "utf8"),
) as {
  readonly repository: ReturnType<typeof layoutCanvasTreemap>;
};

const SIZE = { width: 320, height: 200 } as const;

describe("treemap layout", () => {
  it("lays a repository map out the same way every time", () => {
    const layout = layoutCanvasTreemap(repositoryMapBlock, SIZE);

    expect(layout).toEqual(snapshot.repository);
    expect(layoutCanvasTreemap(repositoryMapBlock, SIZE)).toEqual(layout);
  });

  it("sizes a group by the sum of the leaves it holds", () => {
    const totals = treemapTotals(repositoryMapBlock, "loc");

    expect(totals.get("packages")).toBe(38_400 + 52_100 + 9_400);
    expect(totals.get("octant")).toBe(
      38_400 + 52_100 + 9_400 + 210_300 + 96_200 + 41_000 + 6_200 + 3_100,
    );
  });

  it("gives a larger reading a larger area and tiles the whole frame", () => {
    const layout = layoutCanvasTreemap(repositoryMapBlock, SIZE);
    const web = layout.nodes.find((rect) => rect.nodeId === "web");
    const server = layout.nodes.find((rect) => rect.nodeId === "server");

    expect((web?.width ?? 0) * (web?.height ?? 0)).toBeGreaterThan(
      (server?.width ?? 0) * (server?.height ?? 0),
    );
    const topLevel = layout.nodes.filter((rect) => rect.depth === 1);
    const covered = topLevel.reduce((sum, rect) => sum + rect.width * rect.height, 0);
    expect(covered).toBeCloseTo(SIZE.width * SIZE.height, 0);
  });

  it("lays out from a chosen group so a zoom shows only that subtree", () => {
    const layout = layoutCanvasTreemap(repositoryMapBlock, { ...SIZE, rootId: "packages" });

    expect(layout.rootId).toBe("packages");
    expect(layout.nodes[0]?.nodeId).toBe("packages");
    expect(layout.nodes.some((rect) => rect.nodeId === "web")).toBe(false);
  });

  it("names the full path from the root to a leaf", () => {
    expect(treemapPath(repositoryMapBlock, "web")).toEqual(["octant", "apps", "web"]);
  });

  it("reads a measure's range across the leaves", () => {
    const domain = treemapMeasureDomain(repositoryMapBlock, "edits60");

    expect(domain.min).toBe(4);
    expect(domain.max).toBe(120);
  });
});
