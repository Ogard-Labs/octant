import type {
  CanvasPlanBlock,
  CanvasPlanTask,
  CanvasPlanTaskStatus,
  CanvasPlanView,
  CanvasStatusTone,
} from "@octant/contracts/canvas";
import { Circle, CircleCheck, CircleDot, CircleSlash, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantMenu } from "../../ui/base/OctantMenu";
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
 * Lets a person change a task's status on a surface that can journal it. The
 * host records each change as a new Canvas version and the agent reads it on
 * its next turn; absent, the plan is read-only.
 */
export interface PlanTaskRuntime {
  readonly onSetStatus: (
    blockId: string,
    taskId: string,
    status: CanvasPlanTaskStatus,
  ) => Promise<
    { readonly kind: "accepted" } | { readonly kind: "denied"; readonly message: string }
  >;
}

type SetStatus = (task: CanvasPlanTask, status: CanvasPlanTaskStatus) => void;

/**
 * A plan the person and the agent both work in. The block's `view` is the
 * author's preference; switching here is a reading choice and never revises
 * the Canvas. A status change shows at once and is undone with a reason if
 * the host refuses it.
 */
export function PlanBlock({
  block: authored,
  runtime,
}: {
  readonly block: CanvasPlanBlock;
  readonly runtime?: PlanTaskRuntime;
}) {
  const [view, setView] = useState<CanvasPlanView>(authored.view ?? "checklist");
  const [chosen, setChosen] = useState<ReadonlyMap<string, CanvasPlanTaskStatus>>(new Map());
  const [notice, setNotice] = useState<string>();
  // A reloaded block carries the host's statuses; local choices give way.
  useEffect(() => setChosen(new Map()), [authored]);
  const block: CanvasPlanBlock = {
    ...authored,
    tasks: authored.tasks.map((task) => {
      const status = chosen.get(String(task.taskId));
      return status === undefined ? task : { ...task, status };
    }),
  };
  const setStatus: SetStatus | undefined =
    runtime === undefined
      ? undefined
      : (task, status) => {
          if (task.status === status) return;
          setNotice(undefined);
          setChosen((current) => new Map(current).set(String(task.taskId), status));
          void runtime
            .onSetStatus(String(authored.blockId), String(task.taskId), status)
            .then((result) => {
              if (result.kind === "accepted") return;
              // Back to what the person saw before this change, which may be
              // an accepted change the reload has not delivered yet.
              setChosen((current) => new Map(current).set(String(task.taskId), task.status));
              setNotice(result.message);
            });
        };
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
      {notice === undefined ? null : (
        <p className="canvas-plan__notice" role="status">
          {notice}
        </p>
      )}
      {view === "checklist" ? <PlanChecklist block={block} setStatus={setStatus} /> : null}
      {view === "kanban" ? <PlanBoard block={block} setStatus={setStatus} /> : null}
      {view === "timeline" ? <PlanTimeline block={block} setStatus={setStatus} /> : null}
    </div>
  );
}

function PlanChecklist({
  block,
  setStatus,
}: {
  readonly block: CanvasPlanBlock;
  readonly setStatus: SetStatus | undefined;
}) {
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
                  <PlanTaskRow
                    key={task.taskId}
                    setStatus={setStatus}
                    task={task}
                    titles={titles}
                  />
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
  setStatus,
  task,
  titles,
}: {
  readonly setStatus: SetStatus | undefined;
  readonly task: CanvasPlanTask;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const waitsOn = (task.dependsOn ?? []).map((taskId) => titles.get(taskId) ?? taskId);
  return (
    <li className="canvas-plan__task" data-status={task.status}>
      <PlanStatusMark setStatus={setStatus} task={task} />
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

/**
 * The task's status mark. Where the host can journal a change it opens the
 * four statuses; otherwise it is only a picture of the status.
 */
function PlanStatusMark({
  setStatus,
  task,
}: {
  readonly setStatus: SetStatus | undefined;
  readonly task: CanvasPlanTask;
}) {
  const Icon = STATUS_ICON[task.status];
  const mark = (
    <Icon aria-hidden="true" className="canvas-plan__task-mark" size={16} strokeWidth={1.8} />
  );
  if (setStatus === undefined) return mark;
  return (
    <OctantMenu
      items={STATUS_ORDER.map((status) => {
        const StatusIcon = STATUS_ICON[status];
        return {
          value: status,
          label: STATUS_LABEL[status],
          icon: <StatusIcon aria-hidden="true" size={16} strokeWidth={1.8} />,
        };
      })}
      onValueChange={(value) => {
        const status = STATUS_ORDER.find((candidate) => candidate === value);
        if (status !== undefined) setStatus(task, status);
      }}
      trigger={mark}
      triggerClassName="canvas-plan__status-trigger"
      triggerLabel={`${task.title}: ${STATUS_LABEL[task.status]}. Change status`}
      value={task.status}
    />
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

function PlanBoard({
  block,
  setStatus,
}: {
  readonly block: CanvasPlanBlock;
  readonly setStatus: SetStatus | undefined;
}) {
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
                  <span className="canvas-plan__card-head">
                    <PlanStatusMark setStatus={setStatus} task={task} />
                    <span className="canvas-plan__task-title">{task.title}</span>
                  </span>
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
function PlanTimeline({
  block,
  setStatus,
}: {
  readonly block: CanvasPlanBlock;
  readonly setStatus: SetStatus | undefined;
}) {
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
              <PlanTaskRow key={task.taskId} setStatus={setStatus} task={task} titles={titles} />
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
