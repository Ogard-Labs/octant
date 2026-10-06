import type { CanvasDefinition } from "@octant/contracts/canvas";

type Block = CanvasDefinition["blocks"][number];

/** What a Canvas mostly is, which also picks its colour in the Vivid style. */
export type CanvasDigestKind =
  | "plan"
  | "chart"
  | "numbers"
  | "diagram"
  | "mockup"
  | "table"
  | "document";

export interface CanvasDigest {
  readonly kind: CanvasDigestKind;
  /** The kind in the person's words: "Plan", "Chart". */
  readonly label: string;
  /** Short facts read off the content, most useful first. */
  readonly facts: ReadonlyArray<string>;
  /** A plan's progress, for the bar under its row. */
  readonly progress?: { readonly done: number; readonly total: number };
}

/**
 * A one-line read of a Canvas, from its own blocks: a plan says how many
 * tasks and which comes next, a chart what it plots, a table how many rows.
 * It only ever counts or quotes what the document holds; it never infers.
 */
export function canvasDigest(definition: CanvasDefinition): CanvasDigest {
  const blocks = definition.blocks;
  const plans = blocks.filter(
    (block): block is Extract<Block, { kind: "plan" }> => block.kind === "plan",
  );
  if (plans.length > 0) {
    const tasks = plans.flatMap((plan) => plan.tasks);
    const done = tasks.filter((task) => task.status === "done").length;
    const next =
      tasks.find((task) => task.status === "doing") ??
      tasks.find((task) => task.status === "todo" || task.status === "blocked");
    return {
      kind: "plan",
      label: "Plan",
      facts: [
        `${String(tasks.length)} ${tasks.length === 1 ? "task" : "tasks"}`,
        ...(next === undefined ? [] : [`next: ${next.title}`]),
      ],
      progress: { done, total: tasks.length },
    };
  }
  const chart = blocks.find(
    (block): block is Extract<Block, { kind: "chart" }> => block.kind === "chart",
  );
  if (chart !== undefined) {
    const series = chart.series;
    return {
      kind: "chart",
      label: "Chart",
      facts:
        series.length === 1
          ? [series[0]?.label ?? ""].filter((fact) => fact !== "")
          : [`${String(series.length)} series`],
    };
  }
  const metrics = blocks.filter((block) => block.kind === "metric").length;
  if (metrics > 0 && metrics * 2 >= blocks.length) {
    return { kind: "numbers", label: "Numbers", facts: [`${String(metrics)} figures`] };
  }
  if (
    blocks.some(
      (block) => block.kind === "diagram" || block.kind === "sequence" || block.kind === "state",
    )
  ) {
    return { kind: "diagram", label: "Diagram", facts: [] };
  }
  const mockup = blocks.find(
    (block): block is Extract<Block, { kind: "mockup" }> => block.kind === "mockup",
  );
  if (mockup !== undefined) {
    return { kind: "mockup", label: "Mockup", facts: [`${mockup.device} screen`] };
  }
  const table = blocks.find(
    (block): block is Extract<Block, { kind: "table" }> => block.kind === "table",
  );
  if (table !== undefined && blocks.length <= 3) {
    return {
      kind: "table",
      label: "Table",
      facts: [`${String(table.rows.length)} ${table.rows.length === 1 ? "row" : "rows"}`],
    };
  }
  const sections = blocks.filter((block) => block.kind === "heading").length;
  return {
    kind: "document",
    label: "Document",
    facts: sections > 1 ? [`${String(sections)} sections`] : [],
  };
}
