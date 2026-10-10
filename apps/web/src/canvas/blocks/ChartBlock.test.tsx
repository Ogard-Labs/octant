import { fireEvent, render, screen, within } from "@testing-library/react";
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
      // A funnel is one series, so like a lone line it carries no legend.
      expect(screen.queryAllByRole("button").length > 0).toBe(block.chartType !== "funnel");
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

describe("chart tooltip", () => {
  function barBlock(format?: "compact" | "bytes") {
    return chartBlock({
      blockId: "requests",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "bar",
      ...(format === undefined ? {} : { format }),
      series: [
        {
          seriesId: "requests",
          label: "Requests",
          points: [
            { x: "Mon", y: format === "compact" ? 1_360_000 : 12 },
            { x: "Tue", y: 8 },
          ],
        },
      ],
    });
  }

  function renderBar(format?: "compact" | "bytes") {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [barBlock(format)] }} />);
    const figure = document.querySelector(".canvas-block__chart--bar");
    if (figure === null) throw new Error("Bar chart was not drawn.");
    const mark = figure.querySelector("svg rect.canvas-block__chart-mark");
    if (mark === null) throw new Error("Bar mark was not drawn.");
    return figure as HTMLElement;
  }

  it("shows the series and value on hover and clears it when the pointer leaves", () => {
    const figure = renderBar();
    const mark = figure.querySelector("svg rect.canvas-block__chart-mark");
    if (mark === null) throw new Error("Bar mark was not drawn.");

    fireEvent.pointerEnter(mark);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Requests");
    expect(tip).toHaveTextContent("12");

    fireEvent.pointerLeave(mark);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("follows keyboard focus so a mark is readable without a pointer", () => {
    const figure = renderBar();
    const mark = figure.querySelector("svg rect.canvas-block__chart-mark");
    if (mark === null) throw new Error("Bar mark was not drawn.");
    expect(mark.getAttribute("tabindex")).toBe("0");

    fireEvent.focus(mark);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Requests");
    expect(screen.getByRole("tooltip").textContent).toContain("12");

    fireEvent.blur(mark);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reads a named format in the tooltip and the disclosed table", () => {
    const figure = renderBar("compact");
    const mark = figure.querySelector("svg rect.canvas-block__chart-mark");
    if (mark === null) throw new Error("Bar mark was not drawn.");

    fireEvent.focus(mark);
    // The reading is the shared compact reading, never the raw integer.
    expect(screen.getByRole("tooltip").textContent).toContain("M");
    expect(screen.getByRole("tooltip").textContent).not.toContain("1360000");
  });

  it("serves a non-cartesian chart through the same tooltip and follows keyboard focus", () => {
    const pie = chartBlock({
      blockId: "shares",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "chart",
      chartType: "pie",
      series: [
        {
          seriesId: "share",
          label: "Share",
          points: [
            { x: "Direct", y: 60 },
            { x: "Referral", y: 40 },
          ],
        },
      ],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [pie] }} />);
    const figure = document.querySelector(".canvas-block__chart--pie");
    if (figure === null) throw new Error("Pie chart was not drawn.");
    const mark = figure.querySelector("svg path.canvas-block__chart-mark");
    if (mark === null) throw new Error("Pie mark was not drawn.");
    expect(mark.getAttribute("tabindex")).toBe("0");

    fireEvent.focus(mark);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Direct");
    expect(screen.getByRole("tooltip").textContent).toContain("60");

    fireEvent.blur(mark);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("funnel, radar, and sankey charts", () => {
  function example(chartType: string): CanvasChartBlock {
    const block = chartExampleBlocks.find((candidate) => candidate.chartType === chartType);
    if (block === undefined) throw new Error(`${chartType} example is missing.`);
    return block;
  }

  function figureOf(chartType: string): HTMLElement {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [example(chartType)] }} />);
    const figure = document.querySelector(`.canvas-block__chart--${chartType}`);
    if (!(figure instanceof HTMLElement)) throw new Error(`${chartType} chart was not drawn.`);
    return figure;
  }

  it("reads a funnel stage's share of the first stage and of the stage before, by keyboard and in the table", async () => {
    const user = userEvent.setup();
    const figure = figureOf("funnel");
    const stage = within(figure).getByRole("img").querySelectorAll("rect.canvas-chart__bar")[1];
    if (stage === undefined) throw new Error("Funnel stage was not drawn.");
    expect(stage.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(stage);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Started trial");
    expect(tip).toHaveTextContent("25% of Visited pricing");
    expect(tip).toHaveTextContent("25% of the stage before");
    fireEvent.blur(stage);

    await user.click(within(figure).getByText("View chart data"));
    const table = within(figure).getByRole("table", { name: "Chart readings" });
    expect(within(table).getByRole("columnheader", { name: "Of stage before" })).toBeVisible();
    expect(within(table).getByRole("row", { name: /Paid 410 3.3% 33.1%/ })).toBeVisible();
  });

  it("lists every radar series at the focused axis and hides a series from the legend", async () => {
    const user = userEvent.setup();
    const figure = figureOf("radar");
    const vertex = figure.querySelector("circle.canvas-chart__dot[data-series='0']");
    if (vertex === null) throw new Error("Radar vertex was not drawn.");
    expect(vertex.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(vertex);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Latency");
    expect(tip).toHaveTextContent("Managed");
    expect(tip).toHaveTextContent("Self-hosted");
    fireEvent.blur(vertex);

    await user.click(within(figure).getByRole("button", { name: "Self-hosted" }));
    expect(figure.querySelector("svg [data-series='1']")).toBeNull();
    expect(figure.querySelector("svg [data-series='0']")).not.toBeNull();
    await user.click(within(figure).getByText("View chart data"));
    expect(within(figure).getByRole("columnheader", { name: "Axis" })).toBeVisible();
  });

  it("names a sankey flow by keyboard, drops a hidden node's flows, and lists every flow", async () => {
    const user = userEvent.setup();
    const figure = figureOf("sankey");
    const bands = () => figure.querySelectorAll("path.canvas-chart__flow");
    expect(bands()).toHaveLength(8);
    const band = bands()[0];
    if (band === undefined) throw new Error("Sankey band was not drawn.");
    expect(band.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(band);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Search → Docs");
    expect(screen.getByRole("tooltip")).toHaveTextContent("5.2K");
    fireEvent.blur(band);

    await user.click(within(figure).getByRole("button", { name: "Pricing" }));
    expect(within(figure).getByRole("button", { name: "Pricing" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // Pricing carries four of the eight flows.
    expect(bands()).toHaveLength(4);

    await user.click(within(figure).getByText("View chart data"));
    const table = within(figure).getByRole("table", { name: "Chart readings" });
    expect(within(table).getAllByRole("row")).toHaveLength(9);
    expect(within(table).getByRole("row", { name: /Pricing Left 1.9K 55.9%/ })).toBeVisible();
  });

  it("gives a crowded sankey column and a long sankey chain room instead of overlapping them", () => {
    const sankey = (links: ReadonlyArray<{ source: string; target: string; value: number }>) =>
      chartBlock({
        blockId: `sankey-${String(links.length)}`,
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "chart",
        chartType: "sankey",
        series: [],
        links,
      });
    const fan = sankey(
      Array.from({ length: 63 }, (_value, index) => ({
        source: `Source ${String(index)}`,
        target: "Sink",
        value: 1,
      })),
    );
    const chain = sankey(
      Array.from({ length: 63 }, (_value, index) => ({
        source: `Step ${String(index)}`,
        target: `Step ${String(index + 1)}`,
        value: 1,
      })),
    );
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [fan, chain] }} />);
    const [fanSvg, chainSvg] = [...document.querySelectorAll(".canvas-block__chart--sankey svg")];
    if (fanSvg === undefined || chainSvg === undefined) throw new Error("Sankeys were not drawn.");

    const sources = [...fanSvg.querySelectorAll("rect.canvas-chart__node")]
      .filter((node) => Number(node.getAttribute("x")) === 0)
      .map((node) => ({
        y: Number(node.getAttribute("y")),
        h: Number(node.getAttribute("height")),
      }))
      .sort((a, b) => a.y - b.y);
    expect(sources).toHaveLength(63);
    for (const [index, node] of sources.entries()) {
      expect(node.h).toBeGreaterThanOrEqual(3);
      const next = sources[index + 1];
      if (next !== undefined) expect(node.y + node.h).toBeLessThanOrEqual(next.y);
    }

    const xs = [...chainSvg.querySelectorAll("rect.canvas-chart__node")].map((node) =>
      Number(node.getAttribute("x")),
    );
    for (let index = 1; index < xs.length; index += 1) {
      expect((xs[index] ?? 0) - (xs[index - 1] ?? 0)).toBeGreaterThanOrEqual(56);
    }
    expect(chainSvg.closest(".canvas-chart__scroll")).not.toBeNull();
  });
});

function chartBlock(value: unknown): CanvasChartBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "chart") {
    throw new Error("Chart fixture did not decode as a chart block.");
  }
  return block;
}
