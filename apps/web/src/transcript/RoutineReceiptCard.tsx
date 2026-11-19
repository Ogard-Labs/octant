import type { ThreadRoutineReceipt } from "@octant/contracts";
import { CalendarClock } from "../ui/icons";
import { useContext } from "react";
import { routineScheduleLabel } from "../automation/routinePresentation";
import { OctantButton } from "../ui/base/OctantButton";

export { RoutineOpenContext } from "./routineOpenContext";
import { RoutineOpenContext } from "./routineOpenContext";

/**
 * What a thread's tool call set up, as a card under the turn: the routine's
 * name, when it runs, and whether it waits for the person. A routine made
 * because the person asked is paused, and the card says it was created paused,
 * because nothing runs until they resume it. The card is a receipt of what was
 * created, so it never claims the routine's current state: the thread's
 * Environment lists the live one.
 */
export function RoutineReceiptCard(props: { readonly routine: ThreadRoutineReceipt }) {
  const open = useContext(RoutineOpenContext);
  const { routine } = props;
  return (
    <div className="routine-receipt-card window-no-drag">
      <CalendarClock aria-hidden="true" className="routine-receipt-card__icon" size={16} />
      <span className="routine-receipt-card__text">
        <span className="routine-receipt-card__label">Created automation</span>
        <span className="routine-receipt-card__title">{routine.name}</span>
        <span className="routine-receipt-card__detail">
          {routineScheduleLabel(routine.trigger)}
          {routine.paused ? " · created paused" : ""}
        </span>
      </span>
      {open === undefined ? null : (
        <OctantButton
          onClick={() => open(routine.routineId)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Open
        </OctantButton>
      )}
    </div>
  );
}
