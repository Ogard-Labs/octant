import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import type { CanvasActionRuntime } from "../canvasActionRuntime";
import { CanvasView } from "../CanvasView";
import { canvasFixture, canvasSource } from "../test-fixtures";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

const treemapFixture = {
  ...base,
  blockId: "repository-map",
  kind: "treemap",
  measures: [
    { measureId: "loc", label: "Lines of code" },
    { measureId: "edits", label: "Edits" },
  ],
  sizeBy: "loc",
  colorBy: "edits",
  colorScale: "sequential",
  nodes: [
    { nodeId: "root", label: "Repository" },
    { nodeId: "apps", label: "apps", parentId: "root" },
    {
      nodeId: "web",
      label: "web",
      parentId: "apps",
      sourceId: canvasSource.sourceId,
      values: { loc: 210, edits: 12 },
    },
    { nodeId: "server", label: "server", parentId: "apps", values: { loc: 96, edits: 7 } },
    { nodeId: "packages", label: "packages", parentId: "root" },
    { nodeId: "domain", label: "domain", parentId: "packages", values: { loc: 52, edits: 4 } },
  ],
} as const;

function definition() {
  return { ...canvasFixture, blocks: [treemapFixture] };
}

function runtime(overrides: Partial<CanvasActionRuntime> = {}): CanvasActionRuntime {
  return {
    availability: () => ({
      state: "available",
      capability: { command: "canvas.open-source", effect: "read", requiresApproval: false },
      requiresApproval: false,
    }),
    onExecute: vi.fn().mockResolvedValue({
      kind: "accepted",
      receipt: { outcome: "completed" },
    }),
    ...overrides,
  } as CanvasActionRuntime;
}

function plot(): HTMLElement {
  return screen.getByRole("group", { name: /Treemap with/ });
}

describe("treemap block", () => {
  it("draws a cell for every leaf and a header for a group", () => {
    render(<CanvasView input={definition()} />);

    const figure = document.querySelector(".canvas-block__treemap");
    if (figure === null) throw new Error("Treemap was not drawn.");
    expect(figure.querySelector("[data-node-id='web']")).not.toBeNull();
    expect(figure.querySelector("[data-node-id='domain']")).not.toBeNull();
    expect(figure.querySelector("[data-treemap-group='true']")).not.toBeNull();
  });

  it("switches the size and colour measures from the block header", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    const sizeBy = screen.getByRole("combobox", { name: "Size by" });
    expect(sizeBy).toHaveTextContent("Lines of code");
    await user.click(sizeBy);
    await user.click(await screen.findByRole("option", { name: "Edits" }));
    expect(screen.getByRole("combobox", { name: "Size by" })).toHaveTextContent("Edits");

    const colorBy = screen.getByRole("combobox", { name: "Colour by" });
    await user.click(colorBy);
    await user.click(await screen.findByRole("option", { name: "Lines of code" }));
    expect(screen.getByRole("combobox", { name: "Colour by" })).toHaveTextContent("Lines of code");
  });

  it("zooms into a group on click and back out with Escape", async () => {
    render(<CanvasView input={definition()} />);

    const groupFrame = document.querySelector(".canvas-block__treemap-group-frame");
    if (groupFrame === null) throw new Error("No group to zoom into.");
    fireEvent.click(groupFrame);
    expect(screen.getByRole("navigation", { name: "Zoom path" })).toBeVisible();

    fireEvent.keyDown(plot(), { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Zoom path" })).toBeNull();
  });

  it("moves between cells with the arrow keys and zooms in with Enter", () => {
    render(<CanvasView input={definition()} />);

    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    const active = document.querySelector('[data-active="true"]');
    expect(active).not.toBeNull();
    expect(active?.getAttribute("data-node-id")).toBe("apps");

    fireEvent.keyDown(plot(), { key: "Enter" });
    expect(screen.getByRole("navigation", { name: "Zoom path" })).toBeVisible();
  });

  it("reports a keyboard-selected group's summed readings in its tooltip", () => {
    render(<CanvasView input={definition()} />);

    fireEvent.keyDown(plot(), { key: "ArrowRight" });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Lines of code: 306");
    expect(tooltip).toHaveTextContent("Edits: 19");
  });

  it("keeps a hovered leaf's Open file control after the pointer leaves the cell", async () => {
    const user = userEvent.setup();
    const actionRuntime = runtime();
    render(<CanvasView input={definition()} actionRuntime={actionRuntime} />);

    const cell = document.querySelector("[data-node-id='web'] .canvas-block__treemap-mark");
    if (cell === null) throw new Error("The web cell was not drawn.");
    fireEvent.pointerEnter(cell);
    fireEvent.pointerLeave(cell);

    const plotControl = document.querySelector<HTMLElement>(
      ".canvas-block__treemap > .canvas-block__treemap-open",
    );
    if (plotControl === null) throw new Error("Open file left with the pointer.");
    await user.click(plotControl);
    expect(actionRuntime.onExecute).toHaveBeenCalledTimes(1);
  });

  it("offers Open file for a leaf that names a source and dispatches it", async () => {
    const user = userEvent.setup();
    const actionRuntime = runtime();
    render(<CanvasView input={definition()} actionRuntime={actionRuntime} />);

    await user.click(screen.getByRole("button", { name: "Open file" }));

    expect(actionRuntime.onExecute).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(actionRuntime.onExecute).mock.calls[0]?.[0];
    expect(dispatched?.command.command).toBe("canvas.open-source");
  });

  it("discloses a hierarchical table sortable by each measure", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByText("View treemap data"));
    const region = screen.getByRole("region", { name: "Treemap data" });
    const table = within(region).getByRole("table", { name: "Treemap readings" });
    expect(within(table).getByText("web")).toBeVisible();
    expect(within(table).getByText("packages")).toBeVisible();

    const sort = within(table).getByRole("button", { name: "Sort by Lines of code" });
    await user.click(sort);
    expect(sort).toHaveAttribute("aria-pressed", "true");
  });

  it("never journals a zoom or a switch", () => {
    const definitionInput = definition();
    const before = JSON.stringify(definitionInput);
    render(<CanvasView input={definitionInput} />);

    fireEvent.keyDown(plot(), { key: "ArrowRight" });
    fireEvent.keyDown(plot(), { key: "Enter" });

    expect(JSON.stringify(definitionInput)).toBe(before);
  });
});
