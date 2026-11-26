import { useEffect, useRef } from "react";
import {
  threadImageOffers,
  type ThreadImageArrival,
  type ThreadImageOfferKey,
  type ThreadImageVerdict,
} from "./threadImageOffers";

/**
 * Kept apart from the store, so a module that only makes offers imports no
 * React. Take the pictures offered to this thread while its composer is mounted. The
 * handler is read at the moment a file arrives, so it may change every render.
 */
export function useThreadImageOffers(
  key: ThreadImageOfferKey | undefined,
  onFile: (
    file: File,
    arrival: ThreadImageArrival,
  ) => ThreadImageVerdict | Promise<ThreadImageVerdict>,
): void {
  const handler = useRef(onFile);
  handler.current = onFile;
  useEffect(() => {
    if (key === undefined) return;
    return threadImageOffers.subscribe(key, (file, arrival) => handler.current(file, arrival));
  }, [key]);
}
