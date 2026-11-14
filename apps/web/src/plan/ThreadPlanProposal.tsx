import { ListChecks } from "../ui/icons";
import { useId, useState } from "react";
import { useRegisterComposerMenuAction } from "../composer/ComposerMenuActions";
import { OctantDialog } from "../ui/base/OctantDialog";
import { useThreadPlan } from "./ThreadPlanContext";
import { ThreadPlanPanel } from "./ThreadPlanPanel";

/** First proposals belong to the thread; the dock only opens existing artifacts. */
export function ThreadPlanProposal() {
  const controller = useThreadPlan();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const offered =
    controller !== undefined &&
    controller.status !== "idle" &&
    !(controller.status === "loading" && !open) &&
    (controller.plan === null || controller.plan.status === "withdrawn");
  // Its name and the plan dialog are the same as when it was a button in the
  // row; it is now an item of the + menu, with the row holding no words.
  useRegisterComposerMenuAction(
    "propose-plan",
    controller !== undefined && offered
      ? {
          label: "Propose plan",
          disabled: controller.pending,
          icon: <ListChecks aria-hidden="true" size={14} />,
          onSelect: () => setOpen(true),
        }
      : undefined,
  );
  if (!offered) return null;

  return (
    <OctantDialog
      className="project-dialog thread-plan-proposal"
      label="New plan"
      labelledBy={titleId}
      onClose={() => setOpen(false)}
      open={open}
    >
      <h1 id={titleId}>New plan</h1>
      <ThreadPlanPanel onCancelProposal={() => setOpen(false)} />
    </OctantDialog>
  );
}
