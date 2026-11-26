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

export function threadImageOfferKey(
  mode: "chat" | "work" | "code",
  threadId: string,
): ThreadImageOfferKey {
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
  /**
   * `onLateRefusal` hears a waiting file's refusal once a composer opens and
   * refuses it; an open composer's refusal is the returned result instead.
   */
  readonly offer: (
    key: ThreadImageOfferKey,
    file: File,
    onLateRefusal?: (reason: string) => void,
  ) => Promise<ThreadImageOfferResult>;
  /** Take this thread's pictures: the waiting ones now, later ones as they come. */
  readonly subscribe: (key: ThreadImageOfferKey, taker: Taker) => () => void;
}

export function createThreadImageOffers(): ThreadImageOffers {
  // Oldest first, across every thread.
  let waiting: ReadonlyArray<{
    readonly key: ThreadImageOfferKey;
    readonly file: File;
    readonly onLateRefusal?: ((reason: string) => void) | undefined;
  }> = [];
  const takers = new Map<ThreadImageOfferKey, Set<Taker>>();
  // One composer takes a picture: two open on the same thread would attach it twice.
  const takerOf = (key: ThreadImageOfferKey) => takers.get(key)?.values().next().value;
  const keep = (
    key: ThreadImageOfferKey,
    file: File,
    onLateRefusal: ((reason: string) => void) | undefined,
  ): undefined => {
    waiting = [...waiting, { key, file, onLateRefusal }].slice(-MAX_WAITING_OFFERS_IN_ALL);
    return undefined;
  };
  // A thread's pictures are handed over one at a time. The Code composer
  // uploads each picture and reads as busy only until one upload ends, so
  // pictures handed over together let a message go out with the first and
  // left the rest attached to the next.
  const turns = new Map<ThreadImageOfferKey, Promise<void>>();
  function inTurn<T>(key: ThreadImageOfferKey, deliver: () => T | Promise<T>): Promise<T> {
    const before = turns.get(key);
    // With nothing ahead of it a delivery starts at once, in the same tick.
    const delivered: Promise<T> =
      before === undefined ? (async () => deliver())() : before.then(deliver);
    const settled = delivered.then(
      () => undefined,
      () => undefined,
    );
    turns.set(key, settled);
    void settled.then(() => {
      if (turns.get(key) === settled) turns.delete(key);
    });
    return delivered;
  }
  return {
    async offer(key, file, onLateRefusal) {
      if (takerOf(key) !== undefined) {
        try {
          // The composer may have closed while earlier pictures were handed over.
          const verdict = await inTurn(key, () => takerOf(key)?.(file, "live"));
          if (verdict !== undefined) {
            return verdict.status === "accepted" ? { status: "added" } : verdict;
          }
        } catch {
          return { status: "refused", reason: "The picture could not be added." };
        }
      }
      if (waiting.filter((entry) => entry.key === key).length >= MAX_WAITING_OFFERS) {
        return { status: "full" };
      }
      keep(key, file, onLateRefusal);
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
        // The composer shows its own refusal of a waiting picture, and the
        // offer's maker hears it too: a later file of the same drop that the
        // composer takes clears the composer's warning.
        for (const entry of queued) {
          void inTurn(key, () => {
            // A composer that closed before a picture's turn leaves it waiting.
            const current = takerOf(key);
            if (current === undefined) return keep(key, entry.file, entry.onLateRefusal);
            return current(entry.file, "waiting");
          }).then(
            (verdict) => {
              if (verdict?.status === "refused") entry.onLateRefusal?.(verdict.reason);
            },
            () => entry.onLateRefusal?.("The file could not be added."),
          );
        }
      }
      return () => {
        set.delete(taker);
        if (set.size === 0) takers.delete(key);
      };
    },
  };
}

/**
 * This window's offers: the Browser makes them, and so do files dropped on a
 * sidebar row; the thread composers take them.
 */
export const threadImageOffers = createThreadImageOffers();

export const THREAD_FILE_OFFERS_FULL = `A thread holds at most ${MAX_WAITING_OFFERS} files until its composer opens. Drop the rest on the composer.`;

/**
 * Files dropped on a sidebar row, handed to that thread's composer in order.
 * The composer applies its own limits and says what it refused, but the next
 * file it takes clears that warning, so a drop of several files also says
 * here which were not added and why: at once for an open composer, and as
 * each waiting file is refused once the composer opens. `say` hears the whole
 * drop's summary each time, so the newest sentence is complete. A single file
 * leaves its refusal to the composer alone. Files with no room to wait are
 * named the same way.
 */
export async function offerFilesToThread(
  mode: "chat" | "work" | "code",
  threadId: string,
  files: ReadonlyArray<File>,
  say: (sentence: string) => void,
  offers: ThreadImageOffers = threadImageOffers,
): Promise<void> {
  let full = false;
  const refused: Array<string> = [];
  const summary = (): string => [...refused, ...(full ? [THREAD_FILE_OFFERS_FULL] : [])].join(" ");
  const refuse = (file: File, reason: string): void => {
    if (files.length < 2) return;
    refused.push(`${file.name} was not added. ${reason}`);
  };
  for (const file of files) {
    const result = await offers.offer(threadImageOfferKey(mode, threadId), file, (reason) => {
      refuse(file, reason);
      if (files.length > 1) say(summary());
    });
    if (result.status === "full") full = true;
    if (result.status === "refused") refuse(file, result.reason);
  }
  if (full || refused.length > 0) say(summary());
}
