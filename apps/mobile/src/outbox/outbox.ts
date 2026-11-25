import type { MobileInboxMode } from "@octant/client-runtime";

/**
 * Messages written to a thread while its computer could not be reached. Words
 * alone: an approval, an answer, a stop or any other action is taken by the
 * computer when it is made, or not at all.
 */
export interface WaitingMessage {
  /** The computer's own id for it, the same for every attempt, so it is taken once. */
  readonly id: string;
  readonly hostId: string;
  readonly mode: MobileInboxMode;
  readonly threadId: string;
  readonly text: string;
  readonly writtenAt: string;
  /** Why it waits on the person: the computer's refusal, or its age. */
  readonly refused?: string;
  /** It was sent and no answer came, so its computer may already have it. */
  readonly attempted?: boolean;
}

export interface Outbox {
  readonly messages: ReadonlyArray<WaitingMessage>;
}

export const EMPTY_OUTBOX: Outbox = { messages: [] };

const MAX_MESSAGES = 50;
const MAX_CHARACTERS = 20_000;
/** A thread moves on; older words are offered back rather than sent on their own. */
const SENT_WITHIN_MS = 24 * 60 * 60 * 1_000;

type Thread = Pick<WaitingMessage, "hostId" | "mode" | "threadId">;

const threadKey = (thread: Thread): string => `${thread.hostId}:${thread.mode}:${thread.threadId}`;

export function addWaiting(
  outbox: Outbox,
  message: WaitingMessage,
): { readonly status: "added" | "full" | "too-long" | "empty"; readonly outbox: Outbox } {
  if (message.text.trim().length === 0) return { status: "empty", outbox };
  if (message.text.length > MAX_CHARACTERS) return { status: "too-long", outbox };
  if (outbox.messages.length >= MAX_MESSAGES) return { status: "full", outbox };
  return { status: "added", outbox: { messages: [...outbox.messages, message] } };
}

export function removeWaiting(outbox: Outbox, id: string): Outbox {
  return { messages: outbox.messages.filter((message) => message.id !== id) };
}

export function markRefused(outbox: Outbox, id: string, reason: string): Outbox {
  return {
    messages: outbox.messages.map((message) =>
      message.id === id ? { ...message, refused: reason } : message,
    ),
  };
}

export function markAttempted(outbox: Outbox, id: string): Outbox {
  return outbox.messages.some((message) => message.id === id && message.attempted !== true)
    ? {
        messages: outbox.messages.map((message) =>
          message.id === id ? { ...message, attempted: true } : message,
        ),
      }
    : outbox;
}

/** The person says it still applies. It keeps its id, so it is still taken once. */
export function tryAgain(outbox: Outbox, id: string, now: Date): Outbox {
  return {
    messages: outbox.messages.map((message) => {
      if (message.id !== id) return message;
      const { refused: _refused, ...rest } = message;
      return { ...rest, writtenAt: now.toISOString() };
    }),
  };
}

/** A computer taken off the phone takes the words written for it along. */
export function dropHostsNotIn(outbox: Outbox, hostIds: ReadonlySet<string>): Outbox {
  const messages = outbox.messages.filter((message) => hostIds.has(message.hostId));
  return messages.length === outbox.messages.length ? outbox : { messages };
}

export function waitingFor(outbox: Outbox, thread: Thread): ReadonlyArray<WaitingMessage> {
  return outbox.messages.filter((message) => threadKey(message) === threadKey(thread));
}

/**
 * The next message of each thread on this computer. A thread's messages go in
 * the order they were written, so one that waits on the person holds the rest.
 */
export function dueMessages(
  outbox: Outbox,
  hostId: string,
  now: Date,
): {
  readonly send: ReadonlyArray<WaitingMessage>;
  readonly tooOld: ReadonlyArray<WaitingMessage>;
} {
  const seen = new Set<string>();
  const send: WaitingMessage[] = [];
  const tooOld: WaitingMessage[] = [];
  for (const message of outbox.messages) {
    if (message.hostId !== hostId || seen.has(threadKey(message))) continue;
    seen.add(threadKey(message));
    if (message.refused !== undefined) continue;
    const age = now.getTime() - Date.parse(message.writtenAt);
    (age < SENT_WITHIN_MS ? send : tooOld).push(message);
  }
  return { send, tooOld };
}

function isMessage(value: unknown): value is WaitingMessage {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Readonly<Record<string, unknown>>;
  return (
    ["id", "hostId", "threadId", "text", "writtenAt"].every(
      (key) => typeof entry[key] === "string",
    ) &&
    (entry.mode === "chat" || entry.mode === "work" || entry.mode === "code") &&
    (entry.refused === undefined || typeof entry.refused === "string") &&
    (entry.attempted === undefined || typeof entry.attempted === "boolean")
  );
}

/** What the phone kept, or nothing at all when it cannot be read whole. */
export function parseOutbox(kept: string | null): Outbox {
  if (kept === null) return EMPTY_OUTBOX;
  try {
    const parsed: unknown = JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null || !("messages" in parsed))
      return EMPTY_OUTBOX;
    const { messages } = parsed;
    return Array.isArray(messages) && messages.every(isMessage) ? { messages } : EMPTY_OUTBOX;
  } catch {
    return EMPTY_OUTBOX;
  }
}
