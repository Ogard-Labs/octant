import { useCallback, useEffect, useRef, useState } from "react";

/** How long the Saved mark stays after a setting change resolves. */
export const SETTINGS_SAVED_MS = 2000;

export type SettingsWriteResult = Promise<boolean> | boolean | void;

/**
 * The state behind the Saved mark in the Settings top rail. A write that the
 * host refused (`false`) says nothing; anything else, including the `void` a
 * synchronous handler returns, is read as accepted.
 *
 * `acknowledge` hands the result back untouched when it is not a promise, so a
 * caller that reads a synchronous answer still gets one.
 */
export function useSettingsSaved(): {
  readonly saved: boolean;
  readonly acknowledge: <Result extends SettingsWriteResult>(result: Result) => Result;
} {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), SETTINGS_SAVED_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const acknowledge = useCallback(
    <Result extends SettingsWriteResult>(result: Result): Result => {
      if (result instanceof Promise) {
        // The chained promise resolves to the same answer, so it stands in for
        // the one the caller passed.
        return result.then((accepted: boolean) => {
          if (accepted !== false) flash();
          return accepted;
        }) as Result;
      }
      if (result !== false) flash();
      return result;
    },
    [flash],
  );
  return { saved, acknowledge };
}
