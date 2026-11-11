import { useEffect, useRef } from "react";

/**
 * Pictures another surface of this window has offered to a thread's next
 * message. A composer takes an offer through its own attach path, so every
 * limit, message and thumbnail it already has applies; the offer only gets the
 * file from where it was made to where the composer is, and reports the
 * composer's own answer back.
 *
 * Nothing here is stored: the offers live in this window's memory and a reload
 * drops them. A thread holds at most `MAX_WAITING_OFFERS` waiting pictures and
 * all threads together hold at most `MAX_WAITING_OFFERS_IN_ALL`; past that the
 * oldest waiting picture, of any thread, is dropped first. Rationale: a thread
 * nobody reopens must not keep its pictures in memory for the life of the window.
 */
export const MAX_WAITING_OFFERS = 8;
export const MAX_WAITING_OFFERS_IN_ALL = 16;

export type ThreadImageOfferKey = string;

export function threadImageOfferKey(mode: "work" | "code", threadId: string): ThreadImageOfferKey {
  return `${mode}:${threadId}`;
}

/** How a composer came by a file: it was waiting for the composer, or arrived while it was open. */
export type ThreadImageArrival = "waiting" | "live";

/** What a composer made of a picture: it attached it, or refused it for a reason it can say. */
export type ThreadImageVerdict =
  | { readonly status: "accepted" }
  | { readonly status: "refused"; readonly reason: string };

type Taker = (
  file: File,
  arrival: ThreadImageArrival,
) => ThreadImageVerdict | Promise<ThreadImageVerdict>;

export type ThreadImageOfferResult =
  /** A composer for the thread is open and attached the file. */
  | { readonly status: "added" }
  /** A composer for the thread is open and refused the file. */
  | { readonly status: "refused"; readonly reason: string }
  /** No composer for the thread is open; the file waits for one. */
  | { readonly status: "waiting" }
  /** The thread already has the most pictures that can wait. */
  | { readonly status: "full" };

export interface ThreadImageOffers {
  readonly offer: (key: ThreadImageOfferKey, file: File) => Promise<ThreadImageOfferResult>;
  /** Take this thread's pictures: the waiting ones now, later ones as they come. */
  readonly subscribe: (key: ThreadImageOfferKey, taker: Taker) => () => void;
}

export function createThreadImageOffers(): ThreadImageOffers {
  // Oldest first, across every thread.
  let waiting: ReadonlyArray<{ readonly key: ThreadImageOfferKey; readonly file: File }> = [];
  const takers = new Map<ThreadImageOfferKey, Set<Taker>>();
  return {
    async offer(key, file) {
      // One composer takes it: two open on the same thread would attach it twice.
      const taker = takers.get(key)?.values().next().value;
      if (taker !== undefined) {
        try {
          const verdict = await taker(file, "live");
          return verdict.status === "accepted" ? { status: "added" } : verdict;
        } catch {
          return { status: "refused", reason: "The picture could not be added." };
        }
      }
      if (waiting.filter((entry) => entry.key === key).length >= MAX_WAITING_OFFERS) {
        return { status: "full" };
      }
      waiting = [...waiting, { key, file }].slice(-MAX_WAITING_OFFERS_IN_ALL);
      return { status: "waiting" };
    },
    subscribe(key, taker) {
      const set = takers.get(key) ?? new Set<Taker>();
      const first = set.size === 0;
      set.add(taker);
      takers.set(key, set);
      if (first) {
        const queued = waiting.filter((entry) => entry.key === key);
        waiting = waiting.filter((entry) => entry.key !== key);
        // A refusal of a waiting picture is the composer's to show: it says so
        // itself where the person is, so the verdict is not needed here.
        for (const entry of queued) {
          void Promise.resolve(taker(entry.file, "waiting")).catch(() => undefined);
        }
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
