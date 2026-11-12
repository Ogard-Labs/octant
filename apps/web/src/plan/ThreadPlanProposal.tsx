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
        size="icon"
        title="Propose plan"
        type="button"
        variant="ghost"
      >
        {/* Its name and tooltip say what it offers; the row holds no words. */}
        <ListChecks aria-hidden="true" size={16} />
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
