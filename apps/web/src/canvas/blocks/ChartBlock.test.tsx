import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasChartBlock } from "@octant/contracts/canvas";
import { chartExampleBlocks } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const spoken: Record<string, string> = {
  pie: "pie",
  donut: "donut",
  "stacked-bar": "stacked bar",
  "grouped-bar": "grouped bar",
  "bar-line": "bar and line",
};

describe("chart marks", () => {
  it.each(chartExampleBlocks)(
    "draws a $chartType chart with a legend and a data table",
    async (block) => {
      const user = userEvent.setup();
      render(<CanvasDocument definition={{ ...canvasFixture, blocks: [block] }} />);

      expect(
        screen.getByRole("img", {
          name: new RegExp(`${spoken[block.chartType] ?? block.chartType} chart`),
        }),
      ).toBeVisible();
      expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
      const summary = screen.getByText("View chart data");
      expect(summary.tagName).toBe("SUMMARY");
      await user.click(summary);
      const region = screen.getByRole("region", { name: "Chart data" });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("table", { name: "Chart readings" })).toBeVisible();
    },
  );

  it("hides a pie slice from the legend and keeps the reading in the data table", async () => {
    const user = userEvent.setup();
    const pie = chartExampleBlocks.find((block) => block.chartType === "pie");
    if (pie === undefined) throw new Error("Pie example is missing.");
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [pie] }} />);

    const figure = document.querySelector(".canvas-block__chart--pie");
    if (figure === null) throw new Error("Pie chart was not drawn.");
    expect(figure.querySelector("svg [data-slice='Product']")).not.toBeNull();
    await user.click(within(figure as HTMLElement).getByRole("button", { name: "Product" }));
    expect(within(figure as HTMLElement).getByRole("button", { name: "Product" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(figure.querySelector("svg [data-slice='Product']")).toBeNull();

    expect(
      within(figure as HTMLElement).getByRole("table", { name: "Chart readings" }),
    ).toHaveTextContent("Product");
  });

  it("hides a stacked series from the legend", async () => {
    const user = userEvent.setup();
    const stacked = chartExampleBlocks.find((block) => block.chartType === "stacked-bar");
    if (stacked === undefined) throw new Error("Stacked bar example is missing.");
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [stacked] }} />);

    const figure = document.querySelector(".canvas-block__chart--stacked-bar");
    if (figure === null) throw new Error("Stacked bar chart was not drawn.");
    expect(figure.querySelector("svg [data-series='0']")).not.toBeNull();
    await user.click(within(figure as HTMLElement).getByRole("button", { name: "Product" }));
    expect(figure.querySelector("svg [data-series='0']")).toBeNull();
    expect(figure.querySelector("svg [data-series='1']")).not.toBeNull();
  });

  it("caps pie legend buttons without dropping slices from the chart or data table", () => {
    const pie = chartBlock({
      blockId: "many-slices",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "pie",
      series: [
        {
          seriesId: "share",
          label: "Share",
          points: Array.from({ length: 30 }, (_, index) => ({
            x: `Slice ${String(index + 1)}`,
            y: 1,
          })),
        },
      ],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [pie] }} />);

    const figure = document.querySelector(".canvas-block__chart--pie");
    if (figure === null) throw new Error("Pie chart was not drawn.");
    expect(within(figure as HTMLElement).getAllByRole("button")).toHaveLength(24);
    expect(figure.querySelectorAll("svg [data-slice]")).toHaveLength(30);
    expect(within(figure as HTMLElement).getAllByRole("row")).toHaveLength(31);
  });

  it("lists every scatter reading in the data table when an x value repeats", () => {
    const scatter = chartBlock({
      blockId: "repeat-x",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "scatter",
      series: [
        {
          seriesId: "points",
          label: "Points",
          points: [
            { x: 1, y: 2 },
            { x: 1, y: 5 },
          ],
        },
      ],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [scatter] }} />);

    const figure = document.querySelector(".canvas-block__chart--scatter");
    if (figure === null) throw new Error("Scatter chart was not drawn.");
    const rows = within(figure as HTMLElement).getAllByRole("row");
    // one header plus one row per reading: neither duplicate x is collapsed.
    expect(rows).toHaveLength(3);
    expect(figure.textContent).toContain("2");
    expect(figure.textContent).toContain("5");
  });

  it("keeps numeric and string categories distinct in the axis and data table", () => {
    const grouped = chartBlock({
      blockId: "mixed-x",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "grouped-bar",
      series: [
        {
          seriesId: "east",
          label: "East",
          points: [
            { x: 1, y: 10 },
            { x: "1", y: 20 },
          ],
        },
        {
          seriesId: "west",
          label: "West",
          points: [
            { x: 1, y: 3 },
            { x: "1", y: 7 },
          ],
        },
      ],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [grouped] }} />);

    const figure = document.querySelector(".canvas-block__chart--grouped-bar");
    if (figure === null) throw new Error("Grouped bar chart was not drawn.");
    const labels = [...figure.querySelectorAll(".canvas-block__chart-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["1", "1"]);
    const rows = within(figure as HTMLElement).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["10", "3"]);
    expect(
      within(rows[2] as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["20", "7"]);
  });
  it("leads a lone trend with its last reading and its change since the first", () => {
    const trend = chartBlock({
      blockId: "signups",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "line",
      series: [
        {
          seriesId: "signups",
          label: "Signups",
          points: [
            { x: "W1", y: 120 },
            { x: "W2", y: 180 },
            { x: "W5", y: 310 },
          ],
        },
      ],
    });
    const { container } = render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [trend] }} />,
    );
    const headline = container.querySelector(".canvas-chart__headline");
    expect(headline?.textContent).toBe("310W5+158% since W1");
    // Only the last reading carries a point until the pointer asks for another.
    expect(container.querySelectorAll(".canvas-chart__dot")).toHaveLength(1);
  });
});

function chartBlock(value: unknown): CanvasChartBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "chart") {
    throw new Error("Chart fixture did not decode as a chart block.");
  }
  return block;
}
