import type {
  CanvasPlanBlock,
  CanvasPlanTask,
  CanvasPlanTaskStatus,
  CanvasPlanView,
  CanvasStatusTone,
} from "@octant/contracts/canvas";
import { Circle, CircleCheck, CircleDot, CircleSlash, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { OctantToggleGroup, OctantToggleGroupItem } from "../../ui/base/OctantToggleGroup";
import { TimelineList, type TimelineEntry } from "./StructuredBlocks";

const STATUS_ORDER: ReadonlyArray<CanvasPlanTaskStatus> = ["todo", "doing", "blocked", "done"];

const STATUS_LABEL: Record<CanvasPlanTaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

const STATUS_ICON: Record<CanvasPlanTaskStatus, LucideIcon> = {
  todo: Circle,
  doing: CircleDot,
  blocked: CircleSlash,
  done: CircleCheck,
};

const STATUS_TONE: Record<CanvasPlanTaskStatus, CanvasStatusTone> = {
  todo: "neutral",
  doing: "info",
  blocked: "danger",
  done: "success",
};

const VIEW_LABEL: Record<CanvasPlanView, string> = {
  checklist: "Checklist",
  kanban: "Board",
  timeline: "Timeline",
};

/**
 * A plan the person and the agent both work in. The block's `view` is the
 * author's preference; switching here is a reading choice and never revises
 * the Canvas.
 */
export function PlanBlock({ block }: { readonly block: CanvasPlanBlock }) {
  const [view, setView] = useState<CanvasPlanView>(block.view ?? "checklist");
  const done = block.tasks.filter((task) => task.status === "done").length;
  return (
    <div className="canvas-plan">
      <div className="canvas-plan__head">
        <strong className="canvas-plan__title">{block.title}</strong>
        <span className="canvas-plan__progress">
          {done} of {block.tasks.length} done
        </span>
        <OctantToggleGroup<CanvasPlanView>
          aria-label="Plan view"
          className="canvas-plan__views"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected !== undefined) setView(selected);
          }}
          value={[view]}
        >
          {(["checklist", "kanban", "timeline"] as const).map((option) => (
            <OctantToggleGroupItem key={option} value={option}>
              {VIEW_LABEL[option]}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
      </div>
      {view === "checklist" ? <PlanChecklist block={block} /> : null}
      {view === "kanban" ? <PlanBoard block={block} /> : null}
      {view === "timeline" ? <PlanTimeline block={block} /> : null}
    </div>
  );
}

function PlanChecklist({ block }: { readonly block: CanvasPlanBlock }) {
  const titles = taskTitles(block);
  return (
    <div className="canvas-plan__phases">
      {block.phases.map((phase) => {
        const tasks = block.tasks.filter((task) => task.phaseId === phase.phaseId);
        const done = tasks.filter((task) => task.status === "done").length;
        return (
          <section aria-label={phase.title} className="canvas-plan__phase" key={phase.phaseId}>
            <h4 className="canvas-plan__phase-title">
              {phase.title}
              <span className="canvas-plan__phase-count">
                {done}/{tasks.length}
              </span>
            </h4>
            {tasks.length === 0 ? (
              <p className="canvas-plan__empty">No tasks in this phase yet.</p>
            ) : (
              <ul className="canvas-plan__tasks">
                {tasks.map((task) => (
                  <PlanTaskRow key={task.taskId} task={task} titles={titles} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PlanTaskRow({
  task,
  titles,
}: {
  readonly task: CanvasPlanTask;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const Icon = STATUS_ICON[task.status];
  const waitsOn = (task.dependsOn ?? []).map((taskId) => titles.get(taskId) ?? taskId);
  return (
    <li className="canvas-plan__task" data-status={task.status}>
      <Icon aria-hidden="true" className="canvas-plan__task-mark" size={16} strokeWidth={1.8} />
      <div className="canvas-plan__task-body">
        <span className="canvas-plan__task-title">
          {task.title}
          <span className="sr-only">, {STATUS_LABEL[task.status]}</span>
        </span>
        <PlanTaskFacts task={task} waitsOn={waitsOn} />
        {task.notes === undefined || task.notes === "" ? null : (
          <p className="canvas-plan__task-notes">{task.notes}</p>
        )}
      </div>
    </li>
  );
}

function PlanTaskFacts({
  task,
  waitsOn,
}: {
  readonly task: CanvasPlanTask;
  readonly waitsOn: ReadonlyArray<string>;
}) {
  const facts = [
    task.owner === undefined
      ? undefined
      : (task.owner.label ?? (task.owner.kind === "agent" ? "Agent" : "You")),
    task.estimate,
    task.dueAt === undefined ? undefined : `Due ${formatDay(task.dueAt)}`,
    waitsOn.length === 0 ? undefined : `Waits on ${waitsOn.join(", ")}`,
  ].filter((fact): fact is string => fact !== undefined);
  if (facts.length === 0) return null;
  return <span className="canvas-plan__task-facts">{facts.join(" · ")}</span>;
}

function PlanBoard({ block }: { readonly block: CanvasPlanBlock }) {
  const phaseTitles = new Map(block.phases.map((phase) => [phase.phaseId, phase.title]));
  return (
    <div className="canvas-plan__board">
      {STATUS_ORDER.map((status) => {
        const tasks = block.tasks.filter((task) => task.status === status);
        return (
          <section aria-label={STATUS_LABEL[status]} className="canvas-plan__column" key={status}>
            <h4 className="canvas-plan__column-title">
              {STATUS_LABEL[status]}
              <span className="canvas-plan__phase-count">{tasks.length}</span>
            </h4>
            <ul className="canvas-plan__cards">
              {tasks.map((task) => (
                <li className="canvas-plan__card" data-status={task.status} key={task.taskId}>
                  <span className="canvas-plan__task-title">{task.title}</span>
                  <span className="canvas-plan__task-facts">
                    {[phaseTitles.get(task.phaseId), task.owner?.label, task.estimate]
                      .filter((fact): fact is string => fact !== undefined)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Dated tasks reuse the timeline renderer; tasks without a date follow in
 * dependency order, so what can start first is read first.
 */
function PlanTimeline({ block }: { readonly block: CanvasPlanBlock }) {
  const phaseTitles = new Map(block.phases.map((phase) => [phase.phaseId, phase.title]));
  const dated = block.tasks
    .map((task) => ({ task, startAt: task.startAt ?? task.dueAt }))
    .filter(
      (entry): entry is { task: CanvasPlanTask; startAt: NonNullable<CanvasPlanTask["dueAt"]> } =>
        entry.startAt !== undefined,
    )
    .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  const timeline: ReadonlyArray<TimelineEntry> = dated.map(({ task, startAt }) => ({
    key: String(task.taskId),
    title: task.title,
    startAt,
    status: STATUS_TONE[task.status],
    detail: phaseTitles.get(task.phaseId) ?? "",
  }));
  const undated = dependencyOrder(
    block.tasks.filter((task) => (task.startAt ?? task.dueAt) === undefined),
  );
  const titles = taskTitles(block);
  return (
    <div className="canvas-plan__timeline">
      {timeline.length === 0 ? null : <TimelineList items={timeline} />}
      {undated.length === 0 ? null : (
        <section aria-label="Not scheduled" className="canvas-plan__phase">
          <h4 className="canvas-plan__phase-title">Not scheduled</h4>
          <ul className="canvas-plan__tasks">
            {undated.map((task) => (
              <PlanTaskRow key={task.taskId} task={task} titles={titles} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function taskTitles(block: CanvasPlanBlock): ReadonlyMap<string, string> {
  return new Map(block.tasks.map((task) => [String(task.taskId), task.title]));
}

/**
 * Tasks a task waits on come before it. The domain policy refuses a plan with
 * circular dependencies, so the walk always settles; a dependency outside the
 * given list is simply not waited on here.
 */
function dependencyOrder(tasks: ReadonlyArray<CanvasPlanTask>): ReadonlyArray<CanvasPlanTask> {
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

function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
