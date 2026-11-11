import type { ThreadRoutineReceipt } from "@octant/contracts";
import { CalendarClock } from "lucide-react";
import { createContext, useContext } from "react";
import { routineScheduleLabel } from "../automation/routinePresentation";
import { OctantButton } from "../ui/base/OctantButton";

/** Opens a routine in Automation Center. Absent where the host cannot, so the card shows no button. */
export const RoutineOpenContext = createContext<((routineId: string) => void) | undefined>(
  undefined,
);

/**
 * What a thread's tool call set up, as a card under the turn: the routine's
 * name, when it runs, and whether it waits for the person. A routine made
 * because the person asked is paused, and the card says so, because nothing
 * runs until they resume it.
 */
export function RoutineReceiptCard(props: { readonly routine: ThreadRoutineReceipt }) {
  const open = useContext(RoutineOpenContext);
  const { routine } = props;
  return (
    <div className="routine-receipt-card window-no-drag">
      <CalendarClock
        aria-hidden="true"
        className="routine-receipt-card__icon"
        size={16}
        strokeWidth={1.8}
      />
      <span className="routine-receipt-card__text">
        <span className="routine-receipt-card__label">Created automation</span>
        <span className="routine-receipt-card__title">{routine.name}</span>
        <span className="routine-receipt-card__detail">
          {routineScheduleLabel(routine.trigger)} · {routine.paused ? "paused" : "scheduled"}
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
