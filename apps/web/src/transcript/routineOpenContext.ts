import { createContext } from "react";

/** Opens a routine in Automation Center. Absent where the host cannot, so the card shows no button. */
export const RoutineOpenContext = createContext<((routineId: string) => void) | undefined>(
  undefined,
);
