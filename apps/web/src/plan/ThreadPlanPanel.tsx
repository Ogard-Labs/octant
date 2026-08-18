import { useState } from "react";
import { AlertTriangle, CloudOff, ListChecks, Loader, ShieldAlert } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { PlanCard } from "./PlanCard";
import { useThreadPlan } from "./ThreadPlanContext";
import { type PlanController, type PlanStatus } from "./usePlanController";

export interface ThreadPlanPanelProps {
  /** Injected in tests; otherwise the thread's own plan controller is used. */
  readonly controller?: PlanController;
  /**
   * A read-only thread may still hold a plan — that is the whole point of Plan
   * mode — but a window that cannot command the thread offers no controls.
   */
  readonly readOnly?: boolean;
}

/**
 * Thread-scoped mount for the authoritative plan.
 *
 * Every transition is a host command and nothing renders as changed before the
 * host accepted it. Writing a plan here is deliberately plain: one step per
 * line, in the order they should happen, because that is the shape the host
 * stores and the shape a reader approves.
 */
export function ThreadPlanPanel(props: ThreadPlanPanelProps) {
  const provided = useThreadPlan();
  const controller = props.controller ?? provided;
  const [title, setTitle] = useState("");
  const [stepText, setStepText] = useState("");
  const [revising, setRevising] = useState(false);

  // Outside a thread there is no plan to show, and a panel that invented an
  // empty one would read as "this thread has no plan".
  if (controller === undefined) return null;
  const plan = controller.plan;
  const commandable = props.readOnly !== true;

  if (controller.status !== "ready") {
    return (
      <section aria-label="Plan" className="thread-plan">
        <h3 className="thread-plan__title">Plan</h3>
        <StatusNote status={controller.status} />
        {controller.status === "loading" || controller.status === "idle" ? null : (
          <OctantButton onClick={controller.reload} type="button" variant="secondary">
            Retry
          </OctantButton>
        )}
      </section>
    );
  }

  const writing = plan === null || plan.status === "withdrawn" || revising;

  return (
    <section aria-label="Plan" className="thread-plan">
      <h3 className="thread-plan__title">Plan</h3>
      {plan === null || plan.status === "withdrawn" ? null : (
        <>
          <PlanCard
            busy={controller.pending}
            plan={plan}
            {...(commandable ? { onApprove: () => void controller.approve() } : {})}
            {...(commandable ? { onWithdraw: () => void controller.withdraw() } : {})}
            {...(commandable
              ? {
                  onSetStepStatus: (stepId, status) =>
                    void controller.setStepStatus(stepId, status),
                }
              : {})}
          />
          {!commandable || revising ? null : (
            <OctantButton
              onClick={() => {
                setTitle(plan.title);
                setStepText(
                  plan.steps
                    .map((step) =>
                      step.rationale === undefined
                        ? step.title
                        : `${step.title} — ${step.rationale}`,
                    )
                    .join("\n"),
                );
                setRevising(true);
              }}
              type="button"
              variant="secondary"
            >
              Revise plan
            </OctantButton>
          )}
          <p className="thread-plan__history" role="note">
            {controller.history.length} recorded revision
            {controller.history.length === 1 ? "" : "s"}.
          </p>
        </>
      )}
      {!commandable || !writing ? null : (
        <form
          className="thread-plan__compose"
          onSubmit={(event) => {
            event.preventDefault();
            const steps = parseSteps(stepText);
            if (title.trim() === "" || steps.length === 0) return;
            const submit = revising ? controller.revise : controller.propose;
            void submit(title, steps).then((accepted) => {
              if (!accepted) return;
              setRevising(false);
              setTitle("");
              setStepText("");
            });
          }}
        >
          {plan === null ? (
            <p className="thread-plan__empty" role="note">
              <ListChecks aria-hidden="true" size={13} strokeWidth={1.8} />
              <span>This thread has no plan yet.</span>
            </p>
          ) : null}
          <OctantInput
            aria-label="Plan title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What is this plan for?"
            value={title}
          />
          <OctantTextarea
            aria-label="Plan steps"
            onChange={(event) => setStepText(event.target.value)}
            placeholder={"One step per line.\nAdd a reason after an em dash."}
            rows={5}
            value={stepText}
          />
          <OctantButton
            disabled={
              controller.pending || title.trim() === "" || parseSteps(stepText).length === 0
            }
            type="submit"
            variant="default"
          >
            {revising ? "Save revision" : "Propose plan"}
          </OctantButton>
          {!revising ? null : (
            <OctantButton onClick={() => setRevising(false)} type="button" variant="ghost">
              Cancel
            </OctantButton>
          )}
        </form>
      )}
      {controller.commandMessage === undefined ? null : (
        <p className="thread-plan__command-error" role="alert">
          <AlertTriangle aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{controller.commandMessage}</span>
        </p>
      )}
      <p className="thread-plan__retention" role="note">
        The host records this plan in its journal, so it survives a restart.
      </p>
    </section>
  );
}

/**
 * One step per line, with an optional reason after an em dash.
 *
 * Deliberately not markdown: the steps are a stored, ordered list the host
 * versions and a reader approves, so what is typed has to map onto that list
 * exactly rather than onto a rendering of it.
 */
export function parseSteps(
  value: string,
): ReadonlyArray<{ readonly title: string; readonly rationale?: string }> {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "")
    .map((line) => {
      const [title, ...rest] = line.split(" — ");
      const rationale = rest.join(" — ").trim();
      return {
        title: (title ?? line).trim(),
        ...(rationale === "" ? {} : { rationale }),
      };
    })
    .filter((step) => step.title !== "");
}

const STATUS_COPY: Record<Exclude<PlanStatus, "ready">, string> = {
  idle: "Plans are unavailable in this window.",
  loading: "Loading the plan…",
  unauthorized: "This window is not authorized to read the plan.",
  unavailable: "The host plan service is unavailable.",
  failure: "The plan could not be loaded.",
};

function StatusNote(props: { readonly status: Exclude<PlanStatus, "ready"> }) {
  const Icon =
    props.status === "loading"
      ? Loader
      : props.status === "unauthorized"
        ? ShieldAlert
        : props.status === "unavailable"
          ? CloudOff
          : props.status === "failure"
            ? AlertTriangle
            : ListChecks;
  return (
    <p className="thread-plan__status" data-status={props.status} role="status">
      <Icon aria-hidden="true" size={13} strokeWidth={1.8} />
      <span>{STATUS_COPY[props.status]}</span>
    </p>
  );
}
