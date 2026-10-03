import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
