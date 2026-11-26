import "../styles/thread-plan.css";
import { Check, ChevronDown, Circle, CircleX, Clock3 } from "../ui/icons";
import { useContext, useId, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantSpinner } from "../ui/base/OctantSpinner";
import { ReplyDetailContext, useReplyDisclosures } from "./replyDetail";
import { RevealHiddenStepsContext } from "./revealHiddenSteps";

/** One task in an agent's restated work plan, with the provider's own wording. */
export interface ThreadTaskRow {
  readonly id: string;
  readonly state: "pending" | "running" | "waiting" | "completed" | "failed";
  readonly summary: string;
  /** The provider's wording while the task runs ("Running the tests"). */
  readonly runningSummary?: string;
}

/** The live task list a thread's Tasks panel shows, from the turn it came out of. */
export interface ThreadTaskProgress {
  readonly tasks: ReadonlyArray<ThreadTaskRow>;
  /** Whether the turn that journaled these rows is still writing. */
  readonly running: boolean;
}

export interface ThreadTasksPanelProps {
  readonly tasks: ThreadTaskProgress;
  /**
   * Keeps the list open whether or not the turn runs, for the Tasks dock
   * panel, which a person opened to see it. The transcript leaves it out.
   */
  readonly alwaysOpen?: boolean;
}

/**
 * The mark for one task's state: the same vocabulary the transcript's own rows
 * use, so a running task spins the way a running tool does.
 */
function taskIcon(state: ThreadTaskRow["state"]): ReactNode {
  switch (state) {
    case "running":
      return <OctantSpinner size={12} />;
    case "waiting":
      return <Clock3 aria-hidden="true" size={12} />;
    case "completed":
      return <Check aria-hidden="true" size={12} />;
    case "failed":
      return <CircleX aria-hidden="true" size={12} />;
    case "pending":
      return <Circle aria-hidden="true" size={12} />;
  }
}

const TASK_STATE_WORDS: Readonly<Record<ThreadTaskRow["state"], string>> = {
  pending: "not started",
  running: "in progress",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
};

/**
 * How a task is drawn: a task still marked running when its turn stopped did
 * not finish, so it takes the not-started mark instead of a spinner that would
 * say work is still going on.
 */
function drawnState(task: ThreadTaskRow, turnRunning: boolean): ThreadTaskRow["state"] {
  return task.state === "running" && !turnRunning ? "pending" : task.state;
}

/**
 * How a task is named: its running wording while the turn is writing and the
 * task is in hand, its plain wording otherwise, so a stopped turn never
 * claims work is still going on.
 */
function taskWording(task: ThreadTaskRow, turnRunning: boolean): string {
  return turnRunning && task.state === "running" && task.runningSummary !== undefined
    ? task.runningSummary
    : task.summary;
}

/** The disclosure id of Answers only's "N tasks hidden" line. */
const HIDDEN_TASKS_DISCLOSURE = "quiet:hidden-tasks";

/**
 * The agent's ongoing and planned tasks, live in the conversation.
 *
 * This is a projection of the same journaled task events the transcript folds:
 * the panel answers "what is it working through right now" without unfolding
 * each turn's machinery, and the per-step detail stays in the transcript rows.
 */
export function ThreadTasksPanel(props: ThreadTasksPanelProps) {
  const { tasks, running } = props.tasks;
  // Answers only draws a transcript's tasks its own way (below); the choice
  // to open its hidden tasks is one of the turn's disclosures, so a change of
  // level forgets it. The Tasks dock panel, which a person opened to see the
  // list, always shows it whole.
  const level = useContext(ReplyDetailContext);
  const findOpen = useContext(RevealHiddenStepsContext);
  const disclosures = useReplyDisclosures();
  const tasksOpened = disclosures.isOpen(HIDDEN_TASKS_DISCLOSURE, false);
  const answersOnly = props.alwaysOpen !== true && level === "answers";
  // The list stays open while the agent works through it, so the step in
  // hand is readable without a click, and folds to its summary once the turn
  // settles. Opening or folding it by hand wins over both.
  const [chosenOpen, setChosenOpen] = useState<boolean>();
  const open = chosenOpen ?? (props.alwaysOpen === true || running);
  const listId = useId();
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
  // While the turn writes and nothing needs attention, the header names the
  // task in hand in its running wording instead of the generic status.
  const current =
    running && !attention
      ? tasks.find((task) => task.state === "running" && task.runningSummary !== undefined)
      : undefined;
  if (tasks.length === 0) return null;
  const item = (task: ThreadTaskRow, index: number) => (
    <li data-task-state={drawnState(task, running)} key={task.id}>
      <span aria-hidden="true" className="thread-tasks__index">
        {index + 1}.
      </span>
      <span className="thread-tasks__mark">{taskIcon(drawnState(task, running))}</span>
      <span className="thread-tasks__summary">{taskWording(task, running)}</span>
      {/* The mark is drawn for the eye only, so the state is said in words. */}
      <span className="sr-only">
        ,{" "}
        {task.state === "running" && !running
          ? // A stopped turn's task in hand did not finish; the header says Incomplete.
            "not finished"
          : TASK_STATE_WORDS[task.state]}
      </span>
    </li>
  );
  if (answersOnly) {
    // Kept in sight: a task that failed or waits on the person, and, while the
    // turn runs, the task in hand, which the Working line cannot name (it
    // names only a running tool). The rest of a finished turn's list waits
    // behind one line. Find shows the whole list open, since it searches only
    // what is drawn. The list is drawn here directly, so this line is its one
    // disclosure.
    const keeps = (task: ThreadTaskRow) =>
      task.state === "failed" || task.state === "waiting" || (running && task.state === "running");
    const hidden = tasks.filter((task) => !keeps(task)).length;
    // A running turn's Working line stands for its routine tasks.
    const offersLine = !findOpen && !running && hidden > 0;
    const showsAll = findOpen || (offersLine && tasksOpened);
    const shown = tasks.flatMap((task, index) =>
      showsAll || keeps(task) ? [item(task, index)] : [],
    );
    if (shown.length === 0 && !offersLine) return null;
    return (
      <section
        aria-label="Agent tasks"
        className="thread-tasks"
        data-running={running ? "true" : undefined}
        data-state={state}
      >
        {offersLine ? (
          <OctantButton
            aria-expanded={tasksOpened}
            className="turn-activity__hidden-steps"
            onClick={() => disclosures.choose(HIDDEN_TASKS_DISCLOSURE, !tasksOpened)}
            size="sm"
            type="button"
            variant="link"
          >
            {tasksOpened ? "Hide tasks" : hidden === 1 ? "1 task hidden" : `${hidden} tasks hidden`}
          </OctantButton>
        ) : null}
        {shown.length === 0 ? null : (
          <ol aria-label="Task list" className="thread-tasks__list">
            {shown}
          </ol>
        )}
      </section>
    );
  }

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
        onClick={() => setChosenOpen(!open)}
        size="xs"
        type="button"
        variant="ghost"
      >
        <span className="thread-tasks__header-icon">{taskIcon(state)}</span>
        <span>
          {completed} of {tasks.length} tasks completed
        </span>
        <span className="thread-tasks__status">
          {current === undefined ? status : taskWording(current, running)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="thread-tasks__chevron"
          data-open={open}
          size={12}
        />
      </OctantButton>
      {open ? (
        <ol aria-label="Task list" className="thread-tasks__list" id={listId}>
          {tasks.map(item)}
        </ol>
      ) : null}
    </section>
  );
}
