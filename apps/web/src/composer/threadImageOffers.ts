import { useEffect, useRef } from "react";

/**
 * Pictures another surface of this window has offered to a thread's next
 * message. A composer takes an offer through its own attach path, so every
 * limit, message and thumbnail it already has applies; the offer only gets the
 * file from where it was made to where the composer is.
 *
 * Nothing here is stored: the offers live in this window's memory, a reload
 * drops them, and a thread holds at most `MAX_WAITING_OFFERS` at a time.
 */
export const MAX_WAITING_OFFERS = 8;

export type ThreadImageOfferKey = string;

export function threadImageOfferKey(mode: "work" | "code", threadId: string): ThreadImageOfferKey {
  return `${mode}:${threadId}`;
}

/** How a composer came by a file: it was waiting for the composer, or arrived while it was open. */
export type ThreadImageArrival = "waiting" | "live";

type Taker = (file: File, arrival: ThreadImageArrival) => void;

export type ThreadImageOfferResult =
  /** A composer for the thread is open and has taken the file. */
  | "taken"
  /** No composer for the thread is open; the file waits for one. */
  | "waiting"
  /** The thread already has the most pictures that can wait. */
  | "full";

export interface ThreadImageOffers {
  readonly offer: (key: ThreadImageOfferKey, file: File) => ThreadImageOfferResult;
  /** Take this thread's pictures: the waiting ones now, later ones as they come. */
  readonly subscribe: (key: ThreadImageOfferKey, taker: Taker) => () => void;
}

export function createThreadImageOffers(): ThreadImageOffers {
  const waiting = new Map<ThreadImageOfferKey, File[]>();
  const takers = new Map<ThreadImageOfferKey, Set<Taker>>();
  return {
    offer(key, file) {
      // One composer takes it: two open on the same thread would attach it twice.
      const taker = takers.get(key)?.values().next().value;
      if (taker !== undefined) {
        taker(file, "live");
        return "taken";
      }
      const queue = waiting.get(key) ?? [];
      if (queue.length >= MAX_WAITING_OFFERS) return "full";
      waiting.set(key, [...queue, file]);
      return "waiting";
    },
    subscribe(key, taker) {
      const set = takers.get(key) ?? new Set<Taker>();
      const first = set.size === 0;
      set.add(taker);
      takers.set(key, set);
      if (first) {
        const queued = waiting.get(key) ?? [];
        waiting.delete(key);
        for (const file of queued) taker(file, "waiting");
      }
      return () => {
        set.delete(taker);
        if (set.size === 0) takers.delete(key);
      };
    },
  };
}

/** This window's offers: the Browser makes them, the thread composers take them. */
export const threadImageOffers = createThreadImageOffers();

/**
 * Take the pictures offered to this thread while its composer is mounted. The
 * handler is read at the moment a file arrives, so it may change every render.
 */
export function useThreadImageOffers(
  key: ThreadImageOfferKey | undefined,
  onFile: (file: File, arrival: ThreadImageArrival) => void,
): void {
  const handler = useRef(onFile);
  handler.current = onFile;
  useEffect(() => {
    if (key === undefined) return;
    return threadImageOffers.subscribe(key, (file, arrival) => handler.current(file, arrival));
  }, [key]);
}
