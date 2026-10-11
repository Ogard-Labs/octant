import type {
  CanvasPlanBlock,
  CanvasPlanTask,
  CanvasPlanTaskStatus,
} from "@octant/contracts/canvas";

/**
 * A plan read as a Gantt chart, worked out from the plan alone.
 *
 * The Gantt view is a reading of the plan's own tasks, not a second list of
 * them, so the thread, the sidebar, the preview, and the export draw the same
 * bars from the same block. A task's bar runs from its start to its due day;
 * a task with only one of the two is a one-day bar on that day. A due day
 * before its start is drawn as a one-day bar on the start rather than as a
 * bar that runs backwards. Tasks with neither date are listed, in dependency
 * order, under the chart. Dependency arrows run from the end of the task
 * waited on to the start of the task that waits. The domain policy has
 * already refused duplicate task ids and circular dependencies, so the order
 * always settles.
 */
export interface CanvasPlanGanttLayout {
  readonly width: number;
  readonly height: number;
  /** Where the bars start; the label gutter sits left of it. */
  readonly chartX: number;
  /** The first and last day the chart shows, as `YYYY-MM-DD`. */
  readonly firstDay: string | undefined;
  readonly lastDay: string | undefined;
  readonly dayWidth: number;
  readonly ticks: ReadonlyArray<CanvasPlanGanttTick>;
  readonly bars: ReadonlyArray<CanvasPlanGanttBar>;
  readonly links: ReadonlyArray<CanvasPlanGanttLink>;
  /** Tasks without a date, in the order they can start. */
  readonly unscheduled: ReadonlyArray<string>;
}

export interface CanvasPlanGanttTick {
  /** The day the tick marks, as `YYYY-MM-DD`; the renderer formats it. */
  readonly day: string;
  readonly x: number;
}

export interface CanvasPlanGanttBar {
  readonly taskId: string;
  readonly title: string;
  readonly phaseId: string;
  readonly status: CanvasPlanTaskStatus;
  readonly startDay: string;
  readonly endDay: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The row's label baseline, in the gutter. */
  readonly labelY: number;
}

export interface CanvasPlanGanttLink {
  readonly from: string;
  readonly to: string;
  /** An elbow from the end of `from` to the start of `to`. */
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

export const CANVAS_GANTT_LABEL_GUTTER = 200;
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 16;
const AXIS_HEIGHT = 24;
const MARGIN = 8;
/** The bars' track is about this wide; a long plan narrows its days to fit. */
const TRACK_WIDTH = 640;
const MAX_DAY_WIDTH = 32;
const MIN_DAY_WIDTH = 2;
const DAY_MS = 86_400_000;
/** A link steps this far right of a bar's end before turning toward the next. */
const LINK_STEP = 6;

function dayIndex(iso: string): number {
  return Math.floor(Date.parse(iso.slice(0, 10)) / DAY_MS);
}

function dayString(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Tasks a task waits on come first. A dependency outside the given list is
 * simply not waited on here.
 */
export function canvasPlanDependencyOrder(
  tasks: ReadonlyArray<CanvasPlanTask>,
): ReadonlyArray<CanvasPlanTask> {
  const byId = new Map(tasks.map((task) => [String(task.taskId), task]));
  const ordered: CanvasPlanTask[] = [];
  const placed = new Set<string>();
  const place = (task: CanvasPlanTask): void => {
    if (placed.has(String(task.taskId))) return;
    placed.add(String(task.taskId));
    for (const dependency of task.dependsOn ?? []) {
      const before = byId.get(String(dependency));
      if (before !== undefined) place(before);
    }
    ordered.push(task);
  };
  for (const task of tasks) place(task);
  return ordered;
}

export function layoutCanvasPlanGantt(block: CanvasPlanBlock): CanvasPlanGanttLayout {
  const phaseOrder = new Map(block.phases.map((phase, index) => [String(phase.phaseId), index]));
  const dated: Array<{
    readonly task: CanvasPlanTask;
    readonly start: number;
    readonly end: number;
  }> = [];
  const undated: CanvasPlanTask[] = [];
  for (const task of block.tasks) {
    const start = task.startAt ?? task.dueAt;
    const due = task.dueAt ?? task.startAt;
    if (start === undefined || due === undefined) {
      undated.push(task);
      continue;
    }
    const startIndex = dayIndex(start);
    const dueIndex = dayIndex(due);
    dated.push({ task, start: startIndex, end: Math.max(startIndex, dueIndex) });
  }
  // Rows read by phase, then by start day, then as the author listed them, so
  // the chart reads like the checklist with time added.
  const rows = dated
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (a, b) =>
        (phaseOrder.get(String(a.task.phaseId)) ?? 0) -
          (phaseOrder.get(String(b.task.phaseId)) ?? 0) ||
        a.start - b.start ||
        a.index - b.index,
    );
  const first = rows.length === 0 ? undefined : Math.min(...rows.map((row) => row.start));
  const last = rows.length === 0 ? undefined : Math.max(...rows.map((row) => row.end));
  const days = first === undefined || last === undefined ? 0 : last - first + 1;
  const dayWidth =
    days === 0
      ? MAX_DAY_WIDTH
      : Math.max(MIN_DAY_WIDTH, Math.min(MAX_DAY_WIDTH, TRACK_WIDTH / days));
  const chartX = MARGIN + CANVAS_GANTT_LABEL_GUTTER;
  const top = MARGIN + AXIS_HEIGHT;
  const bars = rows.map((row, rowIndex): CanvasPlanGanttBar => {
    const offset = row.start - (first ?? row.start);
    const y = top + rowIndex * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
    return {
      taskId: String(row.task.taskId),
      title: row.task.title,
      phaseId: String(row.task.phaseId),
      status: row.task.status,
      startDay: dayString(row.start),
      endDay: dayString(row.end),
      x: chartX + offset * dayWidth,
      y,
      width: (row.end - row.start + 1) * dayWidth,
      height: BAR_HEIGHT,
      labelY: y + BAR_HEIGHT / 2,
    };
  });
  const barById = new Map(bars.map((bar) => [bar.taskId, bar]));
  const links = rows.flatMap((row) =>
    (row.task.dependsOn ?? []).flatMap((dependency): ReadonlyArray<CanvasPlanGanttLink> => {
      const from = barById.get(String(dependency));
      const to = barById.get(String(row.task.taskId));
      if (from === undefined || to === undefined) return [];
      const fromX = from.x + from.width;
      const fromY = from.y + from.height / 2;
      const toY = to.y + to.height / 2;
      const turnX = Math.max(fromX + LINK_STEP, to.x - LINK_STEP);
      return [
        {
          from: from.taskId,
          to: to.taskId,
          points: [
            { x: fromX, y: fromY },
            { x: turnX, y: fromY },
            { x: turnX, y: toY },
            { x: to.x, y: toY },
          ],
        },
      ];
    }),
  );
  const ticks: CanvasPlanGanttTick[] = [];
  if (first !== undefined && last !== undefined) {
    // A tick a week on a short plan, and one every four weeks once a week is
    // narrower than a date label; the first day always carries one.
    const step = dayWidth * 7 >= 56 ? 7 : 28;
    for (let day = first; day <= last; day += step) {
      ticks.push({ day: dayString(day), x: chartX + (day - first) * dayWidth });
    }
  }
  const trackRight = chartX + days * dayWidth;
  const linkRight = Math.max(
    trackRight,
    ...links.flatMap((link) => link.points.map((point) => point.x)),
  );
  return {
    width: linkRight + MARGIN,
    height: top + Math.max(rows.length, 1) * ROW_HEIGHT + MARGIN,
    chartX,
    firstDay: first === undefined ? undefined : dayString(first),
    lastDay: last === undefined ? undefined : dayString(last),
    dayWidth,
    ticks,
    bars,
    links,
    unscheduled: canvasPlanDependencyOrder(undated).map((task) => String(task.taskId)),
  };
}
