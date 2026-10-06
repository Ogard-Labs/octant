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
