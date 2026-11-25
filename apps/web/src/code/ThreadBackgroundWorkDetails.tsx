import type { CodeLiveTask } from "@octant/contracts";
import type { CodeThreadPullRequestWait } from "@octant/contracts/code-project-pull-request-switches";
import { useId, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { X } from "../ui/icons";
import { waitDetail, waitKey, waitLabel } from "./threadWaitCopy";
import "./thread-background-work.css";

/** Everything an idle thread still has going, each with its state and its Stop. */
export function ThreadBackgroundWorkDetails(props: {
  readonly tasks: ReadonlyArray<CodeLiveTask>;
  readonly waits: ReadonlyArray<CodeThreadPullRequestWait>;
  readonly stopping: string | undefined;
  readonly message: string | undefined;
  readonly restoreFocus: RefObject<HTMLElement | null>;
  readonly onStopTasks: () => void;
  readonly onStopWait: (wait: CodeThreadPullRequestWait) => void;
  readonly onClose: () => void;
}) {
  const { tasks, waits } = props;
  const titleId = useId();
  const busy = props.stopping !== undefined;
  return (
    <OctantDialog
      open
      label="Background work"
      labelledBy={titleId}
      className="octant-confirmation thread-background-work__dialog"
      restoreFocus={props.restoreFocus}
      onClose={props.onClose}
    >
      <div className="octant-dialog__head">
        <h2 className="octant-confirmation__title" id={titleId}>
          Background work
        </h2>
        <OctantButton
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close background work"
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </OctantButton>
      </div>
      {tasks.length + waits.length === 0 ? (
        <p className="thread-background-work__empty">
          Nothing is running or waiting in this thread.
        </p>
      ) : (
        <ul className="thread-background-work__entries">
          {tasks.map((task, index) => (
            <li key={task.taskId} className="thread-background-work__entry">
              <div className="thread-background-work__entry-text">
                <span className="thread-background-work__command">
                  {task.description ?? "Background task"}
                </span>
              </div>
              <span className="thread-background-work__state">Running</span>
              {/* Tasks share one session, so one Stop ends them all. */}
              {index === tasks.length - 1 ? (
                <OctantButton
                  type="button"
                  size="sm"
                  variant="bare"
                  className="thread-background-work__action"
                  disabled={busy}
                  {...(tasks.length === 1
                    ? { "aria-label": `Stop: ${task.description ?? "Background task"}` }
                    : {})}
                  onClick={props.onStopTasks}
                >
                  {tasks.length === 1 ? "Stop" : "Stop tasks"}
                </OctantButton>
              ) : (
                <span />
              )}
            </li>
          ))}
          {waits.map((wait) => (
            <li key={waitKey(wait)} className="thread-background-work__entry">
              <div className="thread-background-work__entry-text">
                <span>{waitLabel(wait)}</span>
                <span className="thread-background-work__entry-detail">{waitDetail(wait)}</span>
              </div>
              <span className="thread-background-work__state">
                {wait.paused ? "Paused" : "Waiting"}
              </span>
              <OctantButton
                type="button"
                size="sm"
                variant="bare"
                className="thread-background-work__action"
                disabled={busy}
                aria-label={`Stop: ${waitLabel(wait)}`}
                onClick={() => props.onStopWait(wait)}
              >
                Stop
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
      {props.message === undefined ? null : (
        <p className="thread-background-work__message" role="status">
          {props.message}
        </p>
      )}
    </OctantDialog>
  );
}
