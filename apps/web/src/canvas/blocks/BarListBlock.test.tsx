import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts/canvas";
import type { CanvasActionRuntime } from "../canvasActionRuntime";
import { CanvasView } from "../CanvasView";
import { canvasFixture, canvasSource } from "../test-fixtures";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION } as const;

const rows = [
  { label: "apps/web/src/canvas/blocks/BarListBlock.tsx", value: 12, sourceId: undefined },
  { label: "packages/domain/src/canvasPolicy.ts", value: 41 },
  { label: "apps/server/src/canvas/artifactRender.ts", value: 27 },
  { label: "packages/contracts/src/canvas.ts", value: 33 },
  { label: "apps/web/src/styles/canvas.css", value: 19 },
  { label: "packages/theme/src/chartScales.ts", value: 5 },
  { label: "apps/web/src/canvas/ChartTooltip.tsx", value: 9 },
  { label: "packages/domain/src/canvasBarListLayout.ts", value: 7 },
  { label: "apps/server/src/canvas/artifactDocumentRender.ts", value: 3 },
  { label: "packages/contracts/src/canvasIdentity.ts", value: 2 },
] as const;

function barListFixture() {
  return {
    ...base,
    blockId: "hottest-files",
    kind: "bar-list",
    valueLabel: "Edits",
    secondaryLabel: "Lines",
    format: "number",
    rows: [{ ...rows[0], sourceId: canvasSource.sourceId, secondaryValue: 200 }, ...rows.slice(1)],
  } as const;
}

function definition() {
  return { ...canvasFixture, blocks: [barListFixture()] };
}

function runtime(overrides: Partial<CanvasActionRuntime> = {}): CanvasActionRuntime {
  return {
    availability: () => ({
      state: "available",
      capability: { command: "canvas.open-source", effect: "read", requiresApproval: false },
      requiresApproval: false,
    }),
    onExecute: vi.fn().mockResolvedValue({ kind: "accepted", receipt: { outcome: "completed" } }),
    ...overrides,
  } as CanvasActionRuntime;
}

function visibleLabels(): ReadonlyArray<string> {
  return [...document.querySelectorAll(".canvas-block__bar-list-label")].map(
    (element) => element.textContent ?? "",
  );
}

describe("bar list block", () => {
  it("ranks the rows largest first and shows the top rows by default", () => {
    render(<CanvasView input={definition()} />);

    const labels = visibleLabels();
    // The largest reading leads; the top eight are drawn before Show all.
    expect(labels[0]).toBe("packages/domain/src/canvasPolicy.ts");
    expect(labels).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show all 10" })).toBeVisible();
  });

  it("reveals every row through Show all and puts the top rows back", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(visibleLabels()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: "Show all 10" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show top 8" }));
    expect(visibleLabels()).toHaveLength(8);
  });

  it("keeps a hidden row out of the picture but in the disclosed table", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    const hidden = "packages/contracts/src/canvasIdentity.ts";
    expect(visibleLabels()).not.toContain(hidden);
    await user.click(screen.getByText("View bar list data"));
    const region = screen.getByRole("region", { name: "Bar list data" });
    const table = within(region).getByRole("table", { name: "Bar list readings" });
    expect(within(table).getByText(hidden)).toBeVisible();
  });

  it("reads a path label with its directory dimmed and its name at full ink", () => {
    render(<CanvasView input={definition()} />);

    expect(screen.getAllByText("apps/web/src/canvas/blocks/")[0]).toHaveClass(
      "canvas-block__path-dir",
    );
    expect(screen.getAllByText("BarListBlock.tsx")[0]).toHaveClass("canvas-block__path-name");
  });

  it("offers Open file for a row that names a source and dispatches it", async () => {
    const user = userEvent.setup();
    const actionRuntime = runtime();
    render(<CanvasView input={definition()} actionRuntime={actionRuntime} />);

    const openButtons = screen.getAllByRole("button", { name: "Open file" });
    await user.click(openButtons[0] as HTMLElement);

    expect(actionRuntime.onExecute).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(actionRuntime.onExecute).mock.calls[0]?.[0];
    expect(dispatched?.command.command).toBe("canvas.open-source");
  });

  it("flips the ranking to smallest first and back, in the picture and the table", async () => {
    const user = userEvent.setup();
    render(<CanvasView input={definition()} />);

    await user.click(screen.getByRole("button", { name: "Largest first ↓" }));
    const flipped = screen.getByRole("button", { name: "Smallest first ↑" });
    expect(flipped).toHaveAttribute("aria-pressed", "true");
    expect(visibleLabels()[0]).toBe("packages/contracts/src/canvasIdentity.ts");

    await user.click(screen.getByText("View bar list data"));
    const table = screen.getByRole("table", { name: "Bar list readings" });
    expect(within(table).getAllByRole("rowheader")[0]).toHaveTextContent(
      "packages/contracts/src/canvasIdentity.ts",
    );

    await user.click(flipped);
    expect(visibleLabels()[0]).toBe("packages/domain/src/canvasPolicy.ts");
  });

  it("never journals Show all or the ranking order", async () => {
    const user = userEvent.setup();
    const definitionInput = definition();
    const before = JSON.stringify(definitionInput);
    render(<CanvasView input={definitionInput} />);

    await user.click(screen.getByRole("button", { name: "Show all 10" }));
    await user.click(screen.getByRole("button", { name: "Largest first ↓" }));

    expect(JSON.stringify(definitionInput)).toBe(before);
  });
});
