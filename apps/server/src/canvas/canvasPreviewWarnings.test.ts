import { describe, expect, it } from "vitest";
import { decodeCanvasBlock } from "@octant/contracts";
import type { CanvasBlock } from "@octant/contracts/canvas";
import { chartExampleBlocks } from "@octant/domain";
import { canvasPreviewWarnings, type CanvasPreviewPalette } from "./canvasPreviewWarnings";
import { canvasPreviewPalette } from "./canvasPreviewService";

function block(input: unknown): CanvasBlock {
  return decodeCanvasBlock(input);
}

function groupedBar(
  blockId: string,
  series: ReadonlyArray<{ seriesId: string; label: string; values: ReadonlyArray<number> }>,
  categories: ReadonlyArray<string>,
): CanvasBlock {
  return block({
    blockId,
    schemaVersion: 1,
    kind: "chart",
    chartType: "grouped-bar",
    series: series.map((item) => ({
      seriesId: item.seriesId,
      label: item.label,
      points: categories.map((category, index) => ({
        x: category,
        y: item.values[index] ?? 0,
      })),
    })),
  });
}

function richText(blockId: string): CanvasBlock {
  return block({ blockId, schemaVersion: 1, kind: "rich-text", text: "Reading." });
}

function warningsFor(
  blocks: ReadonlyArray<CanvasBlock>,
  options: {
    readonly presentation?: "inline" | "sidebar";
    readonly width?: number;
    readonly palette?: CanvasPreviewPalette;
  } = {},
): ReturnType<typeof canvasPreviewWarnings> {
  return canvasPreviewWarnings({
    definition: { blocks },
    presentation: options.presentation ?? "sidebar",
    width: options.width ?? 720,
    palette: options.palette ?? canvasPreviewPalette("light"),
  });
}

describe("canvasPreviewWarnings", () => {
  it("reports nothing for a document that reads cleanly", () => {
    const blocks = [
      richText("summary"),
      groupedBar(
        "revenue",
        [
          { seriesId: "this", label: "This year", values: [1, 2, 3] },
          { seriesId: "last", label: "Last year", values: [2, 3, 4] },
        ],
        ["Q1", "Q2", "Q3"],
      ),
    ];
    expect(warningsFor(blocks)).toEqual([]);
  });

  it("reports a category label whose slot cannot hold it", () => {
    const blocks = [
      groupedBar(
        "revenue",
        [
          { seriesId: "this", label: "This year", values: [1, 2] },
          { seriesId: "last", label: "Last year", values: [2, 3] },
        ],
        ["Northern territory operations", "Southern territory operations"],
      ),
    ];
    const warnings = warningsFor(blocks, { width: 380 });
    expect(warnings).toContainEqual({
      kind: "clipped-label",
      blockId: "revenue",
      label: "Northern territory operations",
      availablePx: expect.any(Number),
    });
  });

  it("reports a legend with more series than the frame fits in one row", () => {
    const labels = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const blocks = [
      groupedBar(
        "scores",
        labels.map((label, index) => ({
          seriesId: `series-${label}`,
          label: `Series ${label}`,
          values: [index + 1],
        })),
        ["Only category"],
      ),
    ];
    const warnings = warningsFor(blocks, { width: 360 });
    expect(warnings).toContainEqual({
      kind: "legend-overflow",
      blockId: "scores",
      seriesCount: 10,
      fits: expect.any(Number),
    });
  });

  it("reports a chart where every series carries no reading", () => {
    const blocks = [
      groupedBar(
        "flat",
        [
          { seriesId: "this", label: "This year", values: [0, 0] },
          { seriesId: "last", label: "Last year", values: [0, 0] },
        ],
        ["Q1", "Q2"],
      ),
    ];
    const warnings = warningsFor(blocks);
    expect(warnings.filter((warning) => warning.kind === "empty-series")).toHaveLength(2);
    expect(warnings).toContainEqual({
      kind: "empty-series",
      blockId: "flat",
      seriesLabel: "This year",
    });
  });

  it("reports a chart with no series at all as empty", () => {
    const blocks = [
      block({ blockId: "blank", schemaVersion: 1, kind: "chart", chartType: "bar", series: [] }),
    ];
    expect(warningsFor(blocks)).toEqual([{ kind: "empty-series", blockId: "blank" }]);
  });

  it("reports a sankey as no empty series and a funnel's long stage as no clipped slot", () => {
    const blocks = chartExampleBlocks.filter(
      (candidate) =>
        candidate.chartType === "sankey" ||
        candidate.chartType === "funnel" ||
        candidate.chartType === "radar",
    );
    expect(blocks).toHaveLength(3);
    expect(warningsFor(blocks, { width: 360 })).toEqual([]);
  });

  it("reports an inline document that is past the block cap", () => {
    const blocks = Array.from({ length: 13 }, (_unused, index) => richText(`block-${index}`));
    expect(warningsFor(blocks, { presentation: "inline" })).toContainEqual({
      kind: "inline-height-cap-exceeded",
      blockCount: 13,
      limit: 12,
    });
  });

  it("reports ink that does not clear its contrast target on the surface", () => {
    const blocks = [
      groupedBar(
        "revenue",
        [
          { seriesId: "this", label: "This year", values: [1] },
          { seriesId: "last", label: "Last year", values: [2] },
        ],
        ["Q1"],
      ),
    ];
    const washed: CanvasPreviewPalette = {
      workspace: "#ffffff",
      ink: "#111111",
      muted: "#ffffff",
      accent: "#111111",
      series: ["#eeeeee"],
    };
    const warnings = warningsFor(blocks, { palette: washed });
    const contrast = warnings.filter((warning) => warning.kind === "contrast-below-target");
    expect(contrast).toContainEqual({
      kind: "contrast-below-target",
      blockId: "revenue",
      foreground: "#ffffff",
      background: "#ffffff",
      ratio: 1,
      target: 4.5,
    });
    expect(contrast.some((warning) => warning.target === 3)).toBe(true);
  });

  it("leaves the built-in themes free of contrast warnings", () => {
    const blocks = [
      groupedBar(
        "revenue",
        [
          { seriesId: "this", label: "This year", values: [1] },
          { seriesId: "last", label: "Last year", values: [2] },
        ],
        ["Q1"],
      ),
    ];
    for (const theme of ["light", "dark"] as const) {
      const warnings = warningsFor(blocks, { palette: canvasPreviewPalette(theme) });
      expect(warnings.filter((warning) => warning.kind === "contrast-below-target")).toEqual([]);
    }
  });
});
