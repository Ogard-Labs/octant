import { useCallback, useEffect, useRef } from "react";

/**
 * Wraps what a dialog's button does, for a dialog that can outlive the screen it
 * came from: the app closes its screens when it locks, and then the button does
 * nothing.
 */
export function useWhileHere(): (act: () => void) => () => void {
  const here = useRef(false);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  return useCallback(
    (act) => () => {
      if (here.current) act();
    },
    [],
  );
}
