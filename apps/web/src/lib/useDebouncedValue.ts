import { useEffect, useState } from "react";

/**
 * Delays updating the returned value until `delayMs` after `value` stops
 * changing. Useful for heavy search/filter work that should not run on every
 * keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return debounced;
}
