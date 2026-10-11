import type {
  CanvasPlanBlock,
  CanvasPlanTask,
  CanvasPlanTaskStatus,
  CanvasPlanView,
  CanvasStatusTone,
} from "@octant/contracts/canvas";
import { Circle, CircleCheck, CircleDot, CircleSlash, Play, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantMenu } from "../../ui/base/OctantMenu";
import { OctantToggleGroup, OctantToggleGroupItem } from "../../ui/base/OctantToggleGroup";
import { canvasPlanDependencyOrder, layoutCanvasPlanGantt } from "@octant/domain";
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
  gantt: "Gantt",
};

/**
 * Lets a person change a task's status on a surface that can journal it. The
 * host records each change as a new Canvas version and the agent reads it on
 * its next turn; absent, the plan is read-only.
 */
export interface PlanTaskRuntime {
  readonly onSetStatus?: (
    blockId: string,
    taskId: string,
    status: CanvasPlanTaskStatus,
  ) => Promise<
    { readonly kind: "accepted" } | { readonly kind: "denied"; readonly message: string }
  >;
  /**
   * Opens a new-thread draft with the task written into it. It never creates
   * a thread: the person sends the draft, as with any new thread.
   */
  readonly onStartTask?: (planTitle: string, task: CanvasPlanTask) => void;
}

type SetStatus = (task: CanvasPlanTask, status: CanvasPlanTaskStatus) => void;
type StartTask = (task: CanvasPlanTask) => void;

/** What the task rows and cards may do; each is absent where the host cannot. */
interface PlanTaskActions {
  readonly setStatus: SetStatus | undefined;
  readonly startTask: StartTask | undefined;
}

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
  const onSetStatus = runtime?.onSetStatus;
  const setStatus: SetStatus | undefined =
    onSetStatus === undefined
      ? undefined
      : (task, status) => {
          if (task.status === status) return;
          setNotice(undefined);
          setChosen((current) => new Map(current).set(String(task.taskId), status));
          void onSetStatus(String(authored.blockId), String(task.taskId), status)
            // A save that throws (a dropped connection, a failed reload) is
            // a refusal too: the mark goes back and the person is told.
            .catch(() => ({
              kind: "denied" as const,
              message: "The status could not be saved. Try again.",
            }))
            .then((result) => {
              if (result.kind === "accepted") return;
              // Back to what the person saw before this change, which may be
              // an accepted change the reload has not delivered yet.
              setChosen((current) => new Map(current).set(String(task.taskId), task.status));
              setNotice(result.message);
            });
        };
  const onStartTask = runtime?.onStartTask;
  const actions: PlanTaskActions = {
    setStatus,
    startTask: onStartTask === undefined ? undefined : (task) => onStartTask(authored.title, task),
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
          {(["checklist", "kanban", "timeline", "gantt"] as const).map((option) => (
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
      {view === "checklist" ? <PlanChecklist actions={actions} block={block} /> : null}
      {view === "kanban" ? <PlanBoard actions={actions} block={block} /> : null}
      {view === "timeline" ? <PlanTimeline actions={actions} block={block} /> : null}
      {view === "gantt" ? <PlanGantt actions={actions} block={block} /> : null}
    </div>
  );
}

function PlanChecklist({
  actions,
  block,
}: {
  readonly actions: PlanTaskActions;
  readonly block: CanvasPlanBlock;
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
                  <PlanTaskRow actions={actions} key={task.taskId} task={task} titles={titles} />
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
  actions,
  task,
  titles,
}: {
  readonly actions: PlanTaskActions;
  readonly task: CanvasPlanTask;
  readonly titles: ReadonlyMap<string, string>;
}) {
  const waitsOn = (task.dependsOn ?? []).map((taskId) => titles.get(taskId) ?? taskId);
  return (
    <li className="canvas-plan__task" data-status={task.status}>
      <PlanStatusMark setStatus={actions.setStatus} task={task} />
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
      <PlanStartTask startTask={actions.startTask} task={task} />
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

/**
 * Hands an open task to a new thread. It only opens a draft with the task
 * written in; the person sends it like any new thread, so starting a task
 * never creates a thread or grants authority by itself.
 */
function PlanStartTask({
  startTask,
  task,
}: {
  readonly startTask: StartTask | undefined;
  readonly task: CanvasPlanTask;
}) {
  if (startTask === undefined || task.status === "done") return null;
  return (
    <OctantButton
      aria-label={`Start ${task.title} in a new thread`}
      className="canvas-plan__start"
      onClick={() => startTask(task)}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Play aria-hidden="true" size={12} strokeWidth={1.8} />
      Start
    </OctantButton>
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
  actions,
  block,
}: {
  readonly actions: PlanTaskActions;
  readonly block: CanvasPlanBlock;
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
                    <PlanStatusMark setStatus={actions.setStatus} task={task} />
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
  actions,
  block,
}: {
  readonly actions: PlanTaskActions;
  readonly block: CanvasPlanBlock;
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
  const undated = canvasPlanDependencyOrder(
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
              <PlanTaskRow actions={actions} key={task.taskId} task={task} titles={titles} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The plan as bars on days, laid out by the domain so every surface draws the
 * same chart. A bar's tone follows its status, and its status is also said in
 * words beside the title, so the tone never carries it alone. Tasks without a
 * date follow in the order they can start.
 */
function PlanGantt({
  actions,
  block,
}: {
  readonly actions: PlanTaskActions;
  readonly block: CanvasPlanBlock;
}) {
  const layout = layoutCanvasPlanGantt(block);
  const titles = taskTitles(block);
  const byId = new Map(block.tasks.map((task) => [String(task.taskId), task]));
  const unscheduled = layout.unscheduled.flatMap((taskId) => {
    const task = byId.get(taskId);
    return task === undefined ? [] : [task];
  });
  return (
    <div className="canvas-plan__gantt">
      {layout.bars.length === 0 ? null : (
        <div className="canvas-plan__gantt-scroll">
          <svg
            aria-label={`${block.title} as a Gantt chart`}
            className="canvas-plan__gantt-svg"
            height={layout.height}
            role="img"
            viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
            width={layout.width}
          >
            <defs>
              <marker
                className="canvas-plan__gantt-arrowhead"
                id={`gantt-arrow-${String(block.blockId)}`}
                markerHeight={6}
                markerWidth={6}
                orient="auto"
                refX={9}
                refY={5}
                viewBox="0 0 10 10"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {layout.ticks.map((tick) => (
              <g className="canvas-plan__gantt-tick" key={tick.day}>
                <line x1={tick.x} x2={tick.x} y1={20} y2={layout.height} />
                <text x={tick.x + 3} y={14}>
                  {formatDay(`${tick.day}T12:00:00.000Z`)}
                </text>
              </g>
            ))}
            {layout.bars.map((bar) => (
              <g className="canvas-plan__gantt-row" data-status={bar.status} key={bar.taskId}>
                <text className="canvas-plan__gantt-label" x={8} y={bar.labelY}>
                  {/* The gutter is fixed; a long title is shortened here and
                      read whole from the bar's title and the hidden list. */}
                  {bar.title.length > 22 ? `${bar.title.slice(0, 21)}…` : bar.title}
                  <tspan className="canvas-plan__gantt-status">
                    {` · ${STATUS_LABEL[bar.status]}`}
                  </tspan>
                </text>
                <rect
                  className="canvas-plan__gantt-bar"
                  height={bar.height}
                  rx={3}
                  width={bar.width}
                  x={bar.x}
                  y={bar.y}
                >
                  <title>{`${bar.title}: ${STATUS_LABEL[bar.status]}, ${formatDay(`${bar.startDay}T12:00:00.000Z`)} to ${formatDay(`${bar.endDay}T12:00:00.000Z`)}`}</title>
                </rect>
              </g>
            ))}
            {layout.links.map((link) => (
              <polyline
                className="canvas-plan__gantt-link"
                key={`${link.from}-${link.to}`}
                markerEnd={`url(#gantt-arrow-${String(block.blockId)})`}
                points={link.points.map((point) => `${point.x},${point.y}`).join(" ")}
              />
            ))}
          </svg>
        </div>
      )}
      <ul className="canvas-plan__tasks sr-only">
        {layout.bars.map((bar) => (
          <li key={bar.taskId}>
            {`${bar.title}, ${STATUS_LABEL[bar.status]}, ${formatDay(`${bar.startDay}T12:00:00.000Z`)} to ${formatDay(`${bar.endDay}T12:00:00.000Z`)}`}
          </li>
        ))}
      </ul>
      {unscheduled.length === 0 ? null : (
        <section aria-label="Not scheduled" className="canvas-plan__phase">
          <h4 className="canvas-plan__phase-title">Not scheduled</h4>
          <ul className="canvas-plan__tasks">
            {unscheduled.map((task) => (
              <PlanTaskRow actions={actions} key={task.taskId} task={task} titles={titles} />
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

function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
