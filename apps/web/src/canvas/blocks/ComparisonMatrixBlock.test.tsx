import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import { CanvasView } from "../CanvasView";
import { canvasFixture } from "../test-fixtures";

function matrixFixture() {
  return {
    blockId: "state-store",
    schemaVersion: CANVAS_SCHEMA_VERSION,
    kind: "comparison-matrix",
    options: [
      { optionId: "postgres", label: "Postgres", detail: "Managed server" },
      { optionId: "sqlite", label: "SQLite" },
      { optionId: "files", label: "Journal files" },
    ],
    criteria: [
      { criterionId: "durability", label: "Crash safety", weight: 3 },
      { criterionId: "ops", label: "Operational cost", weight: 2, prefer: "lower" },
      { criterionId: "offline", label: "Works offline" },
      { criterionId: "licence", label: "Licence" },
    ],
    cells: [
      { criterionId: "durability", optionId: "postgres", score: 5 },
      { criterionId: "durability", optionId: "sqlite", score: 5, note: "WAL with full sync" },
      { criterionId: "durability", optionId: "files", score: 3 },
      { criterionId: "ops", optionId: "postgres", score: 4 },
      { criterionId: "ops", optionId: "sqlite", score: 1 },
      { criterionId: "ops", optionId: "files", score: 2 },
      { criterionId: "offline", optionId: "postgres", glyph: "partial", note: "Local server only" },
      { criterionId: "offline", optionId: "sqlite", glyph: "yes" },
      { criterionId: "offline", optionId: "files", glyph: "no" },
      { criterionId: "licence", optionId: "sqlite", text: "Public domain" },
    ],
    scoreRange: { min: 1, max: 5 },
    recommendedOptionId: "sqlite",
    recommendation: "No server to run.",
  } as const;
}

function definition() {
  return { ...canvasFixture, blocks: [matrixFixture()] };
}

function matrixTable(): HTMLElement {
  return screen.getByRole("table", { name: /Comparison of 3 options across 4 criteria/ });
}

function columnHeaders(): ReadonlyArray<string> {
  return within(matrixTable())
    .getAllByRole("columnheader")
    .slice(1)
    .map((header) => header.querySelector(".canvas-block__matrix-option-label")?.textContent ?? "");
}

describe("comparison matrix block", () => {
  it("draws options as columns and criteria as rows of a native table", () => {
    render(<CanvasView input={definition()} />);

    expect(columnHeaders()).toEqual(["Postgres", "SQLite", "Journal files"]);
    const rowHeaders = within(matrixTable())
      .getAllByRole("rowheader")
      .map((header) => header.querySelector(".canvas-block__matrix-criterion-label")?.textContent);
    expect(rowHeaders).toEqual([
      "Crash safety",
      "Operational cost",
      "Works offline",
      "Licence",
      "Weighted score",
    ]);
    expect(within(matrixTable()).getByText("Weight 3")).toBeInTheDocument();
    expect(within(matrixTable()).getByText("Lower is better")).toBeInTheDocument();
  });

  it("reads each glyph as a word and an empty cell as not assessed", () => {
    render(<CanvasView input={definition()} />);

    const offline = within(matrixTable()).getByRole("row", { name: /Works offline/ });
    expect(within(offline).getByText("Partial")).toBeInTheDocument();
    expect(within(offline).getByText("Yes")).toBeInTheDocument();
    expect(within(offline).getByText("No")).toBeInTheDocument();
    const licence = within(matrixTable()).getByRole("row", { name: /Licence/ });
    expect(within(licence).getByText("Public domain")).toBeInTheDocument();
    expect(within(licence).getAllByText("Not assessed")).toHaveLength(2);
  });

  it("shows each option's weighted score, the highest one, and the recommended option", () => {
    render(<CanvasView input={definition()} />);

    const totals = within(matrixTable()).getByRole("row", { name: /Weighted score/ });
    // SQLite: crash 1.0 × 3, ops (lower) 1.0 × 2, offline 1.0 × 1 → 6 / 6 → 5 of 5.
    expect(within(totals).getByText("5 of 5")).toBeInTheDocument();
    expect(within(totals).getByText("Highest")).toBeInTheDocument();
    // Licence is text, so it never counts and nobody is missing a reading in it.
    expect(within(totals).queryByText(/not scored/)).not.toBeInTheDocument();
    const recommended = within(matrixTable()).getByRole("columnheader", { name: /SQLite/ });
    expect(within(recommended).getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("No server to run.")).toBeInTheDocument();
  });

  it("numbers each cell note and lists the notes under the matrix", () => {
    render(<CanvasView input={definition()} />);

    const notes = screen.getByRole("list", { name: "Notes" });
    const items = within(notes).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "1Crash safety · SQLite: WAL with full sync",
      "2Works offline · Postgres: Local server only",
    ]);
    const crash = within(matrixTable()).getByRole("row", { name: /Crash safety/ });
    expect(within(crash).getByText("Note 1")).toBeInTheDocument();
  });

  it("orders the options by weighted score as view state and never journals it", async () => {
    const user = userEvent.setup();
    const input = definition();
    const before = JSON.stringify(input);
    render(<CanvasView input={input} />);

    await user.click(screen.getByRole("button", { name: "Order by score" }));
    expect(columnHeaders()).toEqual(["SQLite", "Postgres", "Journal files"]);
    expect(screen.getByRole("button", { name: "Order by score" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Order by score" }));
    expect(columnHeaders()).toEqual(["Postgres", "SQLite", "Journal files"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("scrolls inside its own labelled region so a keyboard reaches every column", () => {
    render(<CanvasView input={definition()} />);

    const region = screen.getByRole("region", { name: /Comparison of 3 options/ });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toContainElement(matrixTable());
  });

  it("discloses a plain reading with one row per option", () => {
    render(<CanvasView input={definition()} />);

    const data = screen.getByRole("table", { name: "Comparison matrix readings" });
    const sqlite = within(data).getByRole("row", { name: /SQLite/ });
    expect(
      within(sqlite)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["5", "1", "Yes", "Public domain", "5 of 5"]);
  });

  it("draws no frame, script, or markup from the definition", () => {
    const { container } = render(<CanvasView input={definition()} />);
    expect(container.querySelector("iframe, script, object, embed")).toBeNull();
  });
});
