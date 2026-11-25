/** One message, under the id its computer knows it by, whose answer was lost. */
export interface UnansweredMessage {
  readonly words: string;
  readonly id: string;
}

export interface ThreadDrafts {
  readonly read: (thread: string) => string;
  readonly keep: (thread: string, text: string) => void;
  /** The words were sent; what was written since stays. */
  readonly sent: (thread: string, text: string) => void;
  readonly onSent: (listener: (thread: string, text: string) => void) => () => void;
  readonly unanswered: (thread: string) => UnansweredMessage | undefined;
  readonly noteUnanswered: (thread: string, message: UnansweredMessage | undefined) => void;
  /** Words whose last send failed without a clear answer. */
  readonly mayBeSent: (thread: string) => string | undefined;
  readonly noteMayBeSent: (thread: string, text: string) => void;
}

/** In memory alone: an unsent message is not written to the phone's storage. */
export function createThreadDrafts(): ThreadDrafts {
  const held = new Map<string, string>();
  const unanswered = new Map<string, UnansweredMessage>();
  const unclear = new Map<string, string>();
  const listeners = new Set<(thread: string, text: string) => void>();
  return {
    read: (thread) => held.get(thread) ?? "",
    keep: (thread, text) => {
      if (text.trim().length === 0) held.delete(thread);
      else held.set(thread, text);
    },
    sent: (thread, text) => {
      if (held.get(thread) === text) held.delete(thread);
      if (unclear.get(thread) === text.trim()) unclear.delete(thread);
      for (const listener of listeners) listener(thread, text);
    },
    onSent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unanswered: (thread) => unanswered.get(thread),
    noteUnanswered: (thread, message) => {
      if (message === undefined) unanswered.delete(thread);
      else unanswered.set(thread, message);
    },
    mayBeSent: (thread) => unclear.get(thread),
    noteMayBeSent: (thread, text) => {
      unclear.set(thread, text.trim());
    },
  };
}

/**
 * The app closes its screens whenever it leaves the front, so what is being
 * written outlives them, and a send that lands meanwhile still finds its draft.
 */
export const liveThreadDrafts = createThreadDrafts();
