import { decodeCanvasBlock, type CanvasPlanBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { launchGanttExample } from "./canvasLayoutExamples";
import { layoutCanvasPlanGantt } from "./canvasPlanGanttLayout";

function plan(value: unknown): CanvasPlanBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "plan") throw new Error("fixture is not a plan");
  return block;
}

describe("layoutCanvasPlanGantt", () => {
  const layout = layoutCanvasPlanGantt(plan(launchGanttExample));

  it("draws one bar per dated task by phase, then by start, from its start to its due day", () => {
    expect(layout.bars.map((bar) => [bar.taskId, bar.status, bar.startDay, bar.endDay])).toEqual([
      ["design", "done", "2026-06-01", "2026-06-05"],
      ["prototype", "doing", "2026-06-08", "2026-06-19"],
      ["art", "blocked", "2026-06-10", "2026-06-24"],
      ["beta", "todo", "2026-06-25", "2026-07-03"],
    ]);
    expect(layout.firstDay).toBe("2026-06-01");
    expect(layout.lastDay).toBe("2026-07-03");
    const [design, prototype] = layout.bars;
    expect(design?.width).toBeCloseTo(5 * layout.dayWidth);
    expect(prototype?.x).toBeCloseTo(layout.chartX + 7 * layout.dayWidth);
    expect(prototype?.y).toBeGreaterThan(design?.y ?? 0);
  });

  it("links the end of each task waited on to the start of the task that waits", () => {
    expect(layout.links.map((link) => [link.from, link.to])).toEqual([
      ["design", "prototype"],
      ["design", "art"],
      ["prototype", "beta"],
      ["art", "beta"],
    ]);
    const beta = layout.bars.find((bar) => bar.taskId === "beta");
    const last = layout.links.at(-1)?.points.at(-1);
    expect(last?.x).toBe(beta?.x);
  });

  it("lists a task with no date under the chart rather than inventing one", () => {
    expect(layout.unscheduled).toEqual(["store"]);
  });

  it("draws a due day before its start as one day on the start, not a bar running backwards", () => {
    const inverted = layoutCanvasPlanGantt(
      plan({
        ...launchGanttExample,
        tasks: [
          {
            taskId: "late",
            phaseId: "build",
            title: "Late",
            status: "todo",
            startAt: "2026-06-10T09:00:00.000Z",
            dueAt: "2026-06-02T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(inverted.bars[0]?.startDay).toBe("2026-06-10");
    expect(inverted.bars[0]?.endDay).toBe("2026-06-10");
    expect(inverted.bars[0]?.width).toBeGreaterThan(0);
  });

  it("snapshots the bar geometry so every surface draws the same chart", () => {
    expect(layout.bars.map((bar) => ({ taskId: bar.taskId, x: bar.x, y: bar.y, width: bar.width })))
      .toMatchInlineSnapshot(`
      [
        {
          "taskId": "design",
          "width": 96.96969696969697,
          "x": 208,
          "y": 38,
        },
        {
          "taskId": "prototype",
          "width": 232.72727272727275,
          "x": 343.75757575757575,
          "y": 66,
        },
        {
          "taskId": "art",
          "width": 290.90909090909093,
          "x": 382.54545454545456,
          "y": 94,
        },
        {
          "taskId": "beta",
          "width": 174.54545454545456,
          "x": 673.4545454545455,
          "y": 122,
        },
      ]
    `);
    expect(layout.ticks.map((tick) => tick.day)).toMatchInlineSnapshot(`
      [
        "2026-06-01",
        "2026-06-08",
        "2026-06-15",
        "2026-06-22",
        "2026-06-29",
      ]
    `);
  });
});
