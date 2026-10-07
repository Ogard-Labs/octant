import { render, screen, within } from "@testing-library/react";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import type { CanvasDefinition } from "@octant/contracts/canvas";
import { decodeCanvasBlock } from "@octant/contracts/canvas";
import { formatCanvasNumber } from "@octant/domain/canvas-number-format";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture, canvasSource } from "../test-fixtures";

function definition(value: unknown): CanvasDefinition {
  return { ...canvasFixture, blocks: [decodeCanvasBlock(value)] };
}

describe("metric and table number formats", () => {
  it("reads a metric value through the format the block names", () => {
    render(
      <CanvasDocument
        definition={definition({
          blockId: "metric-format",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "metric",
          label: "Requests",
          value: 1_360_000,
          format: "compact",
        })}
      />,
    );

    expect(screen.getByText(formatCanvasNumber(1_360_000, "compact"))).toBeVisible();
    expect(screen.queryByText("1360000")).toBeNull();
  });

  it("reads each table column through its own format and leaves a plain column grouped", () => {
    render(
      <CanvasDocument
        definition={definition({
          blockId: "table-format",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "table",
          columns: [
            { id: "size", label: "Size", type: "number", format: "bytes" },
            { id: "count", label: "Count", type: "number" },
          ],
          rows: [[1536, 1_234_567]],
        })}
      />,
    );

    const table = screen.getByRole("table");
    expect(within(table).getByText(formatCanvasNumber(1536, "bytes"))).toBeVisible();
    expect(within(table).getByText(formatCanvasNumber(1_234_567))).toBeVisible();
  });
});

describe("file path labels", () => {
  it("dims the directory and keeps the file name at full ink", () => {
    render(
      <CanvasDocument
        definition={definition({
          blockId: "file-reference-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "file-reference",
          sourceId: canvasSource.sourceId,
          label: "packages/theme/src/color.ts",
        })}
      />,
    );

    expect(screen.getByText("packages/theme/src/")).toHaveClass("canvas-block__path-dir");
    expect(screen.getByText("color.ts")).toHaveClass("canvas-block__path-name");
    expect(screen.getByText("packages/theme/src/").parentElement).toHaveClass("canvas-block__path");
  });
});

function metric(overrides: Record<string, unknown>) {
  return decodeCanvasBlock({
    blockId: "metric-1",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "metric",
    label: "Coverage",
    value: 0.86,
    format: "percent",
    ...overrides,
  });
}

function doc(blocks: ReadonlyArray<ReturnType<typeof decodeCanvasBlock>>): CanvasDefinition {
  return { ...canvasFixture, blocks: [...blocks] };
}

function deltaToneOf(overrides: Record<string, unknown>): string {
  const { container } = render(<CanvasDocument definition={doc([metric(overrides)])} />);
  const delta = container.querySelector(".cmetric-delta");
  if (delta === null) throw new Error("No metric delta was drawn.");
  return [...delta.classList].find((name) => name !== "cmetric-delta") ?? "";
}

describe("metric delta tone", () => {
  it("tones a rise as good when the block says up is better", () => {
    expect(deltaToneOf({ delta: 1200, goodDirection: "up" })).toBe("good");
  });

  it("tones a fall as good when the block says down is better", () => {
    expect(deltaToneOf({ delta: -0.4, goodDirection: "down" })).toBe("good");
  });

  it("tones a rise as bad when the block says down is better", () => {
    expect(deltaToneOf({ delta: 0.4, goodDirection: "down" })).toBe("bad");
  });

  it("keeps the neutral ink when the block does not name a direction", () => {
    expect(deltaToneOf({ delta: 5 })).toBe("flat");
    expect(deltaToneOf({ delta: 5, goodDirection: "neutral" })).toBe("flat");
  });
});

describe("metric sparkline and caption", () => {
  it("draws a sparkline from the metric's readings and shows its caption", () => {
    const { container } = render(
      <CanvasDocument
        definition={doc([
          metric({
            value: 1_360_000,
            format: "compact",
            sparkline: [1.2, 1.24, 1.27, 1.3, 1.31, 1.36],
            caption: "since last release",
          }),
        ])}
      />,
    );

    const line = container.querySelector(".cmetric-sparkline polyline");
    expect(line).not.toBeNull();
    expect(line?.getAttribute("points")?.split(" ")).toHaveLength(6);
    expect(screen.getByText("since last release")).toBeVisible();
  });

  it("draws no sparkline when the block carries none", () => {
    const { container } = render(<CanvasDocument definition={doc([metric({ value: 42 })])} />);

    expect(container.querySelector(".cmetric-sparkline")).toBeNull();
  });
});

describe("metric tile row", () => {
  it("gathers consecutive metric blocks into one responsive tile row", () => {
    const { container } = render(
      <CanvasDocument
        definition={doc([
          metric({ blockId: "m1", label: "Files" }),
          metric({ blockId: "m2", label: "Lines" }),
          metric({ blockId: "m3", label: "Coverage" }),
        ])}
      />,
    );

    const row = container.querySelector(".canvas-metrics");
    if (row === null) throw new Error("No metric tile row was drawn.");
    expect(row.querySelectorAll(".canvas-block__metric")).toHaveLength(3);
  });
});
