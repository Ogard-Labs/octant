import { Check, Circle, CircleX, Clock3, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { TaskActivityRow, ThreadTaskProgress } from "./transcriptActivity";

export interface ThreadTasksPanelProps {
  readonly tasks: ThreadTaskProgress;
}

/**
 * The mark for one task's state: the same vocabulary the transcript's own rows
 * use, so a running task spins the way a running tool does.
 */
function taskIcon(state: TaskActivityRow["state"]): ReactNode {
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
  const { tasks, running } = props.tasks;
  const completed = tasks.filter((task) => task.state === "completed").length;
  // A settled turn whose list is unfinished ended before it finished; the
  // header stays neutral rather than claiming a failure the rows do not state.
  const HeaderIcon = running ? LoaderCircle : completed === tasks.length ? Check : Circle;

  return (
    <section
      aria-label="Agent tasks"
      className="thread-tasks"
      data-running={running ? "true" : undefined}
    >
      <header className="thread-tasks__header">
        <HeaderIcon
          aria-hidden="true"
          className="thread-tasks__header-icon"
          size={13}
          strokeWidth={1.8}
        />
        <span>
          {completed} of {tasks.length} tasks completed
        </span>
      </header>
      <ol aria-label="Task list" className="thread-tasks__list">
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
    </section>
  );
}
