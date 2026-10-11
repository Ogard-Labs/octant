import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import { CanvasView } from "../CanvasView";
import { canvasFixture } from "../test-fixtures";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

const tableFixture = {
  ...base,
  blockId: "table-assets",
  kind: "table",
  columns: [
    { id: "asset", label: "Asset", type: "text" },
    { id: "requests", label: "Requests", type: "number", format: "compact", display: "bar" },
    { id: "errors", label: "Errors", type: "number", display: "heat" },
    { id: "state", label: "State", type: "text", display: "status" },
  ],
  rows: [
    ["apps/web/src/Table.tsx", 1_200_000, 3, "Ready"],
    ["packages/domain/canvas.ts", 300_000, 9, "Blocked"],
    ["README.md", 60_000, 0, "Ready"],
  ],
} as const;

function definition() {
  return { ...canvasFixture, blocks: [tableFixture] };
}

/** The visible body rows' first cell, in the order drawn. */
function firstColumn(): ReadonlyArray<string> {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("td")?.textContent ?? "");
}

describe("sortable table", () => {
  it("keeps the author's row order until a header is clicked", () => {
    render(<CanvasView input={definition()} />);

    expect(firstColumn()).toEqual([
      "apps/web/src/Table.tsx",
      "packages/domain/canvas.ts",
      "README.md",
    ]);
    expect(screen.getByRole("columnheader", { name: "Requests" })).not.toHaveAttribute("aria-sort");
  });

  it("sorts a number column ascending, then descending, and announces the direction", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByRole("button", { name: "Requests" }));
    const header = screen.getByRole("columnheader", { name: "Requests" });
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(firstColumn()).toEqual([
      "README.md",
      "packages/domain/canvas.ts",
      "apps/web/src/Table.tsx",
    ]);

    await user.click(screen.getByRole("button", { name: "Requests" }));
    expect(screen.getByRole("columnheader", { name: "Requests" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(firstColumn()).toEqual([
      "apps/web/src/Table.tsx",
      "packages/domain/canvas.ts",
      "README.md",
    ]);
  });

  it("starts a different column ascending and leaves one sorted header at a time", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByRole("button", { name: "Requests" }));
    await user.click(screen.getByRole("button", { name: "Errors" }));

    expect(screen.getByRole("columnheader", { name: "Errors" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: "Requests" })).not.toHaveAttribute("aria-sort");
    expect(firstColumn()).toEqual([
      "README.md",
      "apps/web/src/Table.tsx",
      "packages/domain/canvas.ts",
    ]);
  });
});

describe("filterable table", () => {
  it("narrows the rows to those a text filter matches", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.type(screen.getByRole("searchbox", { name: "Filter rows" }), "domain");

    expect(firstColumn()).toEqual(["packages/domain/canvas.ts"]);
  });

  it("says so when the filter matches no row", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.type(screen.getByRole("searchbox", { name: "Filter rows" }), "nothing-here");

    expect(screen.getByText("No matching rows.")).toBeVisible();
  });
});

describe("hideable table columns", () => {
  it("hides a column and shows it again from the column control", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "Requests" }));

    expect(screen.queryByRole("columnheader", { name: "Requests" })).toBeNull();
    expect(firstColumn()).toEqual([
      "apps/web/src/Table.tsx",
      "packages/domain/canvas.ts",
      "README.md",
    ]);

    await user.click(screen.getByRole("checkbox", { name: "Requests" }));
    expect(screen.getByRole("columnheader", { name: "Requests" })).toBeVisible();
  });

  it("drops the sort when its column is hidden, so no row order is left unexplained", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByRole("button", { name: "Requests" }));
    expect(firstColumn()[0]).toBe("README.md");

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "Requests" }));
    expect(firstColumn()).toEqual([
      "apps/web/src/Table.tsx",
      "packages/domain/canvas.ts",
      "README.md",
    ]);

    // Showing the column again does not bring back an ordering nobody chose.
    await user.click(screen.getByRole("checkbox", { name: "Requests" }));
    expect(screen.getByRole("columnheader", { name: "Requests" })).not.toHaveAttribute("aria-sort");
  });

  it("will not hide the last visible column", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "Requests" }));
    await user.click(screen.getByRole("checkbox", { name: "Errors" }));
    await user.click(screen.getByRole("checkbox", { name: "State" }));

    expect(screen.getByRole("checkbox", { name: "Asset" })).toBeDisabled();
    expect(screen.getByRole("columnheader", { name: "Asset" })).toBeVisible();
  });
});

describe("table cell displays", () => {
  it("draws an in-cell bar scaled to the column's largest reading and keeps the value", () => {
    const { container } = render(<CanvasView input={definition()} />);

    const fills = container.querySelectorAll(".canvas-block__table-bar-fill");
    expect(fills.length).toBe(3);
    expect(fills[0]?.getAttribute("style")).toContain("width: 100%");
    expect(fills[2]?.getAttribute("style")).toContain("width: 5%");
    expect(screen.getByText("1.2M")).toBeVisible();
  });

  it("tints a heat column on the shared scale and still shows every value", () => {
    const { container } = render(<CanvasView input={definition()} />);

    const tinted = container.querySelectorAll("[data-heat-step]");
    expect(tinted.length).toBe(3);
    expect(container.querySelector("[data-heat-step='4']")).not.toBeNull();
    expect(screen.getByText("9")).toBeVisible();
  });

  it("reads a status column as a badge", () => {
    const { container } = render(<CanvasView input={definition()} />);

    const badges = container.querySelectorAll(".canvas-block__table .badge");
    expect(badges.length).toBe(3);
    expect(badges[0]?.textContent).toBe("Ready");
  });

  it("draws a path column with the shared path style", () => {
    render(<CanvasView input={definition()} />);

    expect(screen.getByText("apps/web/src/")).toHaveClass("canvas-block__path-dir");
    expect(screen.getByText("Table.tsx")).toHaveClass("canvas-block__path-name");
  });
});

describe("table view state", () => {
  it("never journals a sort, a filter, or a hidden column", async () => {
    const user = userEvent.setup();
    const input = definition();
    const before = JSON.stringify(input);
    render(<CanvasView input={input} />);

    await user.click(screen.getByRole("button", { name: "Requests" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter rows" }), "ready");
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "Errors" }));

    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("comment markers on table rows", () => {
  const vendors = {
    ...base,
    blockId: "vendors",
    kind: "table",
    columns: [
      { id: "vendor", label: "Vendor", type: "text" },
      { id: "price", label: "Price", type: "number" },
    ],
    rows: [
      { id: "acme", cells: ["Acme", 12] },
      { id: "globex", cells: ["Globex", 9] },
      ["Initech", 30],
    ],
  } as const;

  function withRows(rows: ReadonlyArray<unknown>) {
    return { ...canvasFixture, blocks: [{ ...vendors, rows }] };
  }

  function comments(onOpen = vi.fn()) {
    return {
      openCounts: new Map([["vendors", 2]]),
      openRowCounts: new Map([["vendors", new Map([["globex", 2]])]]),
      onOpen,
    };
  }

  /** The row a marker sits in, read by its first data cell. */
  function rowOf(marker: HTMLElement): string {
    return marker.closest("tr")?.querySelectorAll("td")[1]?.textContent ?? "";
  }

  it("offers a marker on each row with an id and none on a row without one", () => {
    render(<CanvasView comments={comments()} input={withRows(vendors.rows)} />);

    expect(rowOf(screen.getByRole("button", { name: "Comment on row Acme" }))).toBe("Acme");
    expect(rowOf(screen.getByRole("button", { name: "2 open comments on row Globex" }))).toBe(
      "Globex",
    );
    expect(screen.queryByRole("button", { name: /on row Initech/ })).toBeNull();
  });

  it("draws no comment gutter on a table whose rows carry no id, or where comments are off", () => {
    const { unmount } = render(
      <CanvasView comments={comments()} input={withRows([["Initech", 30]])} />,
    );
    expect(screen.queryByRole("columnheader", { name: "Comments" })).toBeNull();
    unmount();
    render(<CanvasView input={withRows(vendors.rows)} />);
    expect(screen.queryByRole("button", { name: /on row/ })).toBeNull();
  });

  it("keeps a row's thread on that row through a sort, a filter, and a revision", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { rerender } = render(
      <CanvasView comments={comments(onOpen)} input={withRows(vendors.rows)} />,
    );
    const marked = () => screen.getByRole("button", { name: "2 open comments on row Globex" });

    await user.click(screen.getByRole("button", { name: "Price" }));
    expect(firstDataColumn()).toEqual(["Globex", "Acme", "Initech"]);
    expect(rowOf(marked())).toBe("Globex");

    await user.type(screen.getByRole("searchbox", { name: "Filter rows" }), "glo");
    expect(firstDataColumn()).toEqual(["Globex"]);
    expect(rowOf(marked())).toBe("Globex");

    // The agent inserts a row above it and changes its price: the id holds.
    await user.clear(screen.getByRole("searchbox", { name: "Filter rows" }));
    rerender(
      <CanvasView
        comments={comments(onOpen)}
        input={withRows([
          { id: "umbrella", cells: ["Umbrella", 1] },
          { id: "acme", cells: ["Acme", 12] },
          { id: "globex", cells: ["Globex Corp", 40] },
        ])}
      />,
    );
    expect(rowOf(screen.getByRole("button", { name: "2 open comments on row Globex Corp" }))).toBe(
      "Globex Corp",
    );

    screen.getByRole("button", { name: "2 open comments on row Globex Corp" }).focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("vendors", "globex");
  });
});

/** The visible body rows' first data cell, after the comment gutter. */
function firstDataColumn(): ReadonlyArray<string> {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[1]?.textContent ?? "");
}
