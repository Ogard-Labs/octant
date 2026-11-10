import { ListChecks } from "lucide-react";
import { useId, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { useThreadPlan } from "./ThreadPlanContext";
import { ThreadPlanPanel } from "./ThreadPlanPanel";

/** First proposals belong to the thread; the dock only opens existing artifacts. */
export function ThreadPlanProposal() {
  const controller = useThreadPlan();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  if (
    controller === undefined ||
    controller.status === "idle" ||
    (controller.status === "loading" && !open) ||
    (controller.plan !== null && controller.plan.status !== "withdrawn")
  )
    return null;

  return (
    <>
      <OctantButton
        aria-label="Propose plan"
        disabled={controller.pending}
        onClick={() => setOpen(true)}
        ref={trigger}
        size="sm"
        title="Propose plan"
        type="button"
        variant="ghost"
      >
        {/* Named in words: as a bare tick-list beside other bare glyphs in the
            composer's toolbar, nobody could tell what it offered. */}
        <ListChecks aria-hidden="true" size={14} strokeWidth={1.7} />
        <span>Plan</span>
      </OctantButton>
      <OctantDialog
        className="project-dialog thread-plan-proposal"
        label="New plan"
        labelledBy={titleId}
        onClose={() => setOpen(false)}
        open={open}
        restoreFocus={trigger}
      >
        <h1 id={titleId}>New plan</h1>
        <ThreadPlanPanel onCancelProposal={() => setOpen(false)} />
      </OctantDialog>
    </>
  );
}
