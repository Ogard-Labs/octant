import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import { CanvasView } from "../CanvasView";
import { canvasFixture } from "../test-fixtures";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

const matrixFixture = {
  ...base,
  blockId: "commits-by-hour",
  kind: "heatmap",
  layout: "matrix",
  valueLabel: "Commits",
  scale: "sequential",
  rows: [
    { rowId: "mon", label: "Mon" },
    { rowId: "tue", label: "Tue" },
    { rowId: "wed", label: "Wed" },
  ],
  columns: [
    { columnId: "h09", label: "09" },
    { columnId: "h10", label: "10" },
    { columnId: "h11", label: "11" },
  ],
  cells: [
    { rowId: "mon", columnId: "h09", value: 3 },
    { rowId: "mon", columnId: "h10", value: 7, note: "After the review" },
    { rowId: "tue", columnId: "h11", value: 1 },
    { rowId: "wed", columnId: "h09", value: 5 },
  ],
} as const;

const calendarFixture = {
  ...base,
  blockId: "test-failures",
  kind: "heatmap",
  layout: "calendar",
  valueLabel: "Test failures",
  scale: "diverging",
  days: [
    { date: "2026-09-01", value: 0 },
    { date: "2026-09-02", value: 4, note: "Flaky suite" },
    { date: "2026-09-03", value: 2 },
  ],
} as const;

function matrixDefinition() {
  return { ...canvasFixture, blocks: [matrixFixture] };
}

function calendarDefinition() {
  return { ...canvasFixture, blocks: [calendarFixture] };
}

function plot(name: RegExp): HTMLElement {
  return screen.getByRole("group", { name });
}

describe("heatmap block", () => {
  it("draws a cell for every coordinate and a dashed cell for a missing one", () => {
    render(<CanvasView input={matrixDefinition()} />);

    const figure = document.querySelector(".canvas-block__heatmap");
    if (figure === null) throw new Error("Heatmap was not drawn.");
    expect(figure.querySelector("[data-row-id='mon'][data-column-id='h09']")).not.toBeNull();
    expect(
      figure.querySelectorAll(".canvas-block__heatmap-plot .canvas-block__heatmap-mark.is-missing")
        .length,
    ).toBe(5);
  });

  it("moves between cells with the arrow keys and shows the shared tooltip", () => {
    render(<CanvasView input={matrixDefinition()} />);

    fireEvent.keyDown(plot(/Heatmap with/), { key: "ArrowRight" });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Mon · 09");
    expect(tip).toHaveTextContent("Commits: 3");

    fireEvent.keyDown(plot(/Heatmap with/), { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mon · 10");

    fireEvent.keyDown(plot(/Heatmap with/), { key: "ArrowDown" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tue · 10");
    expect(screen.getByRole("tooltip")).toHaveTextContent("no reading");
  });

  it("names a cell's note on hover", () => {
    render(<CanvasView input={matrixDefinition()} />);

    const mark = document.querySelector("[data-row-id='mon'][data-column-id='h10']");
    if (mark === null) throw new Error("No cell to hover.");
    fireEvent.pointerEnter(mark);

    expect(screen.getByRole("tooltip")).toHaveTextContent("Commits: 7 — After the review");
  });

  it("sorts the matrix rows by their total as view state", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={matrixDefinition()} />);

    await user.click(screen.getByRole("button", { name: "Sort rows by total" }));
    const sort = screen.getByRole("button", { name: /Rows: total/ });
    expect(sort).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByText("View heatmap data"));
    const table = screen.getByRole("table", { name: "Heatmap readings" });
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((cell) => cell.textContent)).toEqual(["Mon", "Wed", "Tue"]);
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("lays a calendar out as a week grid and moves between days", () => {
    render(<CanvasView input={calendarDefinition()} />);

    const calendarPlot = plot(/Calendar heatmap from/);
    expect(document.querySelectorAll("[data-date]").length).toBeGreaterThanOrEqual(3);

    fireEvent.keyDown(calendarPlot, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("2026-09-01");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Test failures: 0");

    fireEvent.keyDown(calendarPlot, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("2026-09-02");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Flaky suite");
  });

  it("never journals a sort or a keyboard move", () => {
    const definitionInput = matrixDefinition();
    const before = JSON.stringify(definitionInput);
    render(<CanvasView input={definitionInput} />);

    fireEvent.keyDown(plot(/Heatmap with/), { key: "ArrowRight" });

    expect(JSON.stringify(definitionInput)).toBe(before);
  });
});
