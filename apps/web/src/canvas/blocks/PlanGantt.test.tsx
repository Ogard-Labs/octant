import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCanvasBlock, type CanvasPlanBlock } from "@octant/contracts/canvas";
import { launchGanttExample, layoutCanvasPlanGantt } from "@octant/domain";
import { PlanBlock } from "./PlanBlock";

function plan(): CanvasPlanBlock {
  const block = decodeCanvasBlock(launchGanttExample);
  if (block.kind !== "plan") throw new Error("fixture is not a plan");
  return block;
}

describe("plan Gantt view", () => {
  it("draws a bar per dated task where the domain layout placed it, toned by status", () => {
    const { container } = render(<PlanBlock block={plan()} />);
    expect(screen.getByRole("img", { name: "Launch plan as a Gantt chart" })).toBeInTheDocument();
    const layout = layoutCanvasPlanGantt(plan());
    const rows = [...container.querySelectorAll(".canvas-plan__gantt-row")];
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(
      layout.bars.map((bar) => bar.status),
    );
    const firstBar = rows[0]?.querySelector("rect");
    expect(Number(firstBar?.getAttribute("x"))).toBe(layout.bars[0]?.x);
    expect(Number(firstBar?.getAttribute("width"))).toBe(layout.bars[0]?.width);
    expect(container.querySelectorAll(".canvas-plan__gantt-link")).toHaveLength(4);
    // The status is said in words beside the bar, not only by its tone.
    expect(rows[2]).toHaveTextContent("Zone art pass · Blocked");
    expect(screen.getByRole("region", { name: "Not scheduled" })).toHaveTextContent(
      "Store listing",
    );
  });

  it("switches to the Gantt view and back without asking the host for anything", async () => {
    const onSetStatus = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <PlanBlock block={{ ...plan(), view: "checklist" }} runtime={{ onSetStatus }} />,
    );
    expect(container.querySelector(".canvas-plan__gantt")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Gantt" }));
    expect(container.querySelector(".canvas-plan__gantt")).not.toBeNull();
    expect(onSetStatus).not.toHaveBeenCalled();
  });
});
