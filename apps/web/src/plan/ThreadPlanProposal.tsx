import { ListChecks } from "lucide-react";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { useThreadPlan } from "./ThreadPlanContext";
import { ThreadPlanPanel } from "./ThreadPlanPanel";

/** First proposals belong to the thread; the dock only opens existing artifacts. */
export function ThreadPlanProposal() {
  const controller = useThreadPlan();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
        <ListChecks aria-hidden="true" size={16} strokeWidth={1.8} />
      </OctantButton>
      <OctantDialog
        className="thread-plan-proposal"
        label="Propose plan"
        onClose={() => setOpen(false)}
        open={open}
        restoreFocus={trigger}
      >
        <ThreadPlanPanel />
        <OctantButton onClick={() => setOpen(false)} type="button" variant="ghost">
          Cancel
        </OctantButton>
      </OctantDialog>
    </>
  );
}
