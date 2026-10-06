import { Check, ChevronDown, Circle, CircleX, Clock3, LoaderCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/** One task in an agent's restated work plan, with the provider's own wording. */
export interface ThreadTaskRow {
  readonly id: string;
  readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
  readonly summary: string;
}

/** The live task list a thread's Tasks panel shows, from the turn it came out of. */
export interface ThreadTaskProgress {
  readonly tasks: ReadonlyArray<ThreadTaskRow>;
  /** Whether the turn that journaled these rows is still writing. */
  readonly running: boolean;
}

export interface ThreadTasksPanelProps {
  readonly tasks: ThreadTaskProgress;
}

/**
 * The mark for one task's state: the same vocabulary the transcript's own rows
 * use, so a running task spins the way a running tool does.
 */
function taskIcon(state: ThreadTaskRow["state"]): ReactNode {
  switch (state) {
    case "running":
      return <LoaderCircle aria-hidden="true" size={12} strokeWidth={1.8} />;
    case "waiting":
      return <Clock3 aria-hidden="true" size={12} strokeWidth={1.8} />;
    case "completed":
      return <Check aria-hidden="true" size={12} strokeWidth={1.8} />;
    case "failed":
      return <CircleX aria-hidden="true" size={12} strokeWidth={1.8} />;
    case "pending":
      return <Circle aria-hidden="true" size={12} strokeWidth={1.8} />;
  }
}

/**
 * The agent's ongoing and planned tasks, live in the conversation.
 *
 * This is a projection of the same journaled task events the transcript folds:
 * the panel answers "what is it working through right now" without unfolding
 * each turn's machinery, and the per-step detail stays in the transcript rows.
 */
export function ThreadTasksPanel(props: ThreadTasksPanelProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { tasks, running } = props.tasks;
  const completed = tasks.filter((task) => task.state === "completed").length;
  const failed = tasks.filter((task) => task.state === "failed").length;
  const waiting = tasks.filter((task) => task.state === "waiting").length;
  // A settled turn whose list is unfinished ended before it finished; the
  // header stays neutral rather than claiming a failure the rows do not state.
  const state =
    failed > 0
      ? "failed"
      : waiting > 0
        ? "waiting"
        : completed === tasks.length
          ? "completed"
          : running
            ? "running"
            : "pending";
  const attention = [
    failed > 0 ? `${failed} failed` : undefined,
    waiting > 0 ? `${waiting} waiting` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const status =
    attention || (state === "completed" ? "Complete" : running ? "In progress" : "Incomplete");
  if (tasks.length === 0) return null;

  return (
    <section
      aria-label="Agent tasks"
      className="thread-tasks"
      data-running={running ? "true" : undefined}
      data-state={state}
    >
      <OctantButton
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className="thread-tasks__header"
        onClick={() => setOpen((current) => !current)}
        size="xs"
        type="button"
        variant="ghost"
      >
        <span className="thread-tasks__header-icon">{taskIcon(state)}</span>
        <span>
          {completed} of {tasks.length} tasks completed
        </span>
        <span className="thread-tasks__status">{status}</span>
        <ChevronDown
          aria-hidden="true"
          className="thread-tasks__chevron"
          data-open={open}
          size={12}
        />
      </OctantButton>
      {open ? (
        <ol aria-label="Task list" className="thread-tasks__list" id={listId}>
          {tasks.map((task, index) => (
            <li data-task-state={task.state} key={task.id}>
              <span aria-hidden="true" className="thread-tasks__index">
                {index + 1}.
              </span>
              <span className="thread-tasks__mark">{taskIcon(task.state)}</span>
              <span className="thread-tasks__summary">{task.summary}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
