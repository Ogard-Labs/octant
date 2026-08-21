import type { ThreadPlanStepId, ThreadPlanStepStatus } from "@octant/contracts";
import { CheckCircle2, Circle, CircleDot, CircleSlash, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useThreadPlan } from "./ThreadPlanContext";
import type { PlanController } from "./usePlanController";

export interface ThreadTaskViewerProps {
  /** Injected in tests; ordinary thread surfaces use their shared controller. */
  readonly controller?: PlanController;
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
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (trigger.current?.contains(event.target) || panel.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      queueMicrotask(() => trigger.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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

  return (
    <div className="thread-task-viewer">
      <OctantButton
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} task progress`}
        className="octant-chip thread-task-viewer__trigger"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        type="button"
        variant="ghost"
      >
        <LoaderCircle aria-hidden="true" size={14} strokeWidth={1.8} />
        {progressLabel}
      </OctantButton>
      {open ? (
        <div
          aria-label="Task progress"
          className="popover-panel thread-task-viewer__popover window-no-drag"
          id={panelId}
          ref={panel}
          role="dialog"
        >
          <header className="thread-task-viewer__header">
            <strong>{plan.title}</strong>
            <span>
              {plan.status === "proposed"
                ? "Awaiting approval"
                : `${String(done)} of ${String(counted.length)} done`}
            </span>
          </header>
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
        </div>
      ) : null}
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
