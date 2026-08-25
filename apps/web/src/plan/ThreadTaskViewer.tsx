import type { ThreadPlanStepId, ThreadPlanStepStatus } from "@octant/contracts";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  CircleSlash,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { useThreadPlan } from "./ThreadPlanContext";
import type { PlanController } from "./usePlanController";

export interface ThreadTaskViewerProps {
  /** Injected in tests; ordinary thread surfaces use their shared controller. */
  readonly controller?: PlanController;
  /**
   * Server-derived checkout evidence for this thread. The viewer deliberately
   * accepts this as an optional projection: when the host has not observed a
   * checkout it omits the summary instead of deriving a count in the browser.
   */
  readonly changedFiles?: ThreadTaskChangedFiles;
}

export interface ThreadTaskChangedFiles {
  readonly kind: "observed";
  readonly changedPathCount: number;
  readonly freshness: "fresh" | "stale";
}

const STEP_LABELS: Record<ThreadPlanStepStatus, string> = {
  pending: "Not started",
  "in-progress": "In progress",
  done: "Done",
  dropped: "Dropped",
};

/** Compact task progress for the active thread, backed by its durable plan. */
export function ThreadTaskViewer(props: ThreadTaskViewerProps) {
  const shared = useThreadPlan();
  const controller = props.controller ?? shared;
  const [open, setOpen] = useState(false);

  if (controller === undefined || controller.status !== "ready") {
    return null;
  }
  const plan = controller.plan;
  if (plan === null || plan.status === "withdrawn") return null;

  const counted = plan.steps.filter((step) => step.status !== "dropped");
  const done = counted.filter((step) => step.status === "done").length;
  const activeIndex = counted.findIndex(
    (step) => step.status === "in-progress" || step.status === "pending",
  );
  const currentStep = activeIndex === -1 ? counted.length : activeIndex + 1;
  const progressLabel =
    plan.status === "proposed"
      ? `Review ${String(counted.length)}-step plan`
      : `Step ${String(currentStep)} / ${String(counted.length)}`;
  const ProgressIcon =
    plan.status === "proposed" ? ListChecks : activeIndex === -1 ? CheckCircle2 : LoaderCircle;
  const changedFilesLabel =
    props.changedFiles === undefined
      ? undefined
      : `${String(props.changedFiles.changedPathCount)} ${
          props.changedFiles.changedPathCount === 1 ? "file" : "files"
        } changed${props.changedFiles.freshness === "stale" ? " · stale" : ""}`;

  return (
    <div className="thread-task-viewer">
      <OctantPopover
        align="center"
        className="thread-task-viewer__popover window-no-drag"
        onOpenChange={setOpen}
        open={open}
        side="top"
        title="Task progress"
        trigger={
          <>
            <ProgressIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            {progressLabel}
            {changedFilesLabel === undefined ? null : (
              <span className="thread-task-viewer__evidence">{changedFilesLabel}</span>
            )}
          </>
        }
        triggerClassName="octant-chip thread-task-viewer__trigger"
        // The label replaces the visible content rather than adding to it, so a
        // reader who cannot see the chip only hears that progress exists unless
        // the progress itself is spelled out here.
        triggerLabel={`${open ? "Hide" : "Show"} task progress · ${progressLabel}${
          changedFilesLabel === undefined ? "" : ` · ${changedFilesLabel}`
        }`}
        triggerVariant="ghost"
      >
        <header className="thread-task-viewer__header">
          <strong>{plan.title}</strong>
          <span>
            {plan.status === "proposed"
              ? "Awaiting approval"
              : `${String(done)} of ${String(counted.length)} done`}
          </span>
        </header>
        {changedFilesLabel === undefined ? null : (
          <p className="thread-task-viewer__evidence-detail" role="status">
            {changedFilesLabel}
          </p>
        )}
        <ol className="thread-task-viewer__steps">
          {plan.steps.map((step) => (
            <li data-step-status={step.status} key={step.stepId}>
              <span className="thread-task-viewer__mark">
                <TaskIcon status={step.status} />
              </span>
              <span className="thread-task-viewer__body">
                <span className="thread-task-viewer__title">{step.title}</span>
                {step.rationale === undefined ? null : (
                  <span className="thread-task-viewer__rationale">{step.rationale}</span>
                )}
                <span className="thread-task-viewer__state">{STEP_LABELS[step.status]}</span>
              </span>
              {plan.status !== "approved" ? null : (
                <TaskActions
                  busy={controller.pending}
                  onSetStepStatus={(status) => void controller.setStepStatus(step.stepId, status)}
                  status={step.status}
                  stepId={step.stepId}
                  title={step.title}
                />
              )}
            </li>
          ))}
        </ol>
        {plan.status !== "proposed" ? null : (
          <OctantButton
            disabled={controller.pending}
            onClick={() => void controller.approve()}
            type="button"
            variant="default"
          >
            Approve plan
          </OctantButton>
        )}
      </OctantPopover>
    </div>
  );
}

function TaskActions(props: {
  readonly busy: boolean;
  readonly onSetStepStatus: (status: ThreadPlanStepStatus) => void;
  readonly status: ThreadPlanStepStatus;
  readonly stepId: ThreadPlanStepId;
  readonly title: string;
}) {
  return (
    <span className="thread-task-viewer__actions" data-step-id={props.stepId}>
      {props.status === "pending" ? (
        <Action
          busy={props.busy}
          label={`Start ${props.title}`}
          onClick={() => props.onSetStepStatus("in-progress")}
        >
          Start
        </Action>
      ) : null}
      {props.status === "in-progress" ? (
        <Action
          busy={props.busy}
          label={`Finish ${props.title}`}
          onClick={() => props.onSetStepStatus("done")}
        >
          Finish
        </Action>
      ) : null}
      {props.status === "done" || props.status === "dropped" ? (
        <Action
          busy={props.busy}
          label={`Reopen ${props.title}`}
          onClick={() => props.onSetStepStatus("pending")}
        >
          Reopen
        </Action>
      ) : (
        <Action
          busy={props.busy}
          label={`Drop ${props.title}`}
          onClick={() => props.onSetStepStatus("dropped")}
        >
          Drop
        </Action>
      )}
    </span>
  );
}

function Action(props: {
  readonly busy: boolean;
  readonly children: string;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <OctantButton
      aria-label={props.label}
      disabled={props.busy}
      onClick={props.onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      {props.children}
    </OctantButton>
  );
}

function TaskIcon(props: { readonly status: ThreadPlanStepStatus }) {
  const iconProps = { "aria-hidden": true, size: 14, strokeWidth: 1.8 } as const;
  if (props.status === "done") return <CheckCircle2 {...iconProps} />;
  if (props.status === "in-progress") return <CircleDot {...iconProps} />;
  if (props.status === "dropped") return <CircleSlash {...iconProps} />;
  return <Circle {...iconProps} />;
}
