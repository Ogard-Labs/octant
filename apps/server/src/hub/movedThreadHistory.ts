// A moved Work or Code thread's earlier conversation, as the thread it arrived
// as keeps it. It is journaled on the thread's own aggregate, so it is the
// thread's from then on and erased with it, and its first turn here carries it
// once, as a disclosed handoff block. It is the person's own conversation on
// their own computer, so it is not framed as outside content; any outside
// content it held already marked the source thread, and that mark moves with it.

import {
  THREAD_MOVED_HISTORY_AGGREGATE,
  THREAD_MOVED_HISTORY_EVENT_NAMES,
  MovedHistoryDelivered,
  MovedHistoryImported,
  type EventActor,
  type MovedHistoryEntry,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { FramedExternalContent } from "../context/externalContentFraming";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

/** The most of the earlier conversation one handoff carries; older words are named as omitted. */
export const MOVED_HISTORY_HANDOFF_CHARACTERS = 200_000;

const decodeImported = Schema.decodeUnknownSync(MovedHistoryImported);

export function registerMovedHistoryEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_MOVED_HISTORY_EVENT_NAMES.imported, 1, MovedHistoryImported)
    .register(THREAD_MOVED_HISTORY_EVENT_NAMES.delivered, 1, MovedHistoryDelivered);
}

export class MovedThreadHistory {
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #clock: () => string;
  readonly #uuid: () => string;
  readonly #actor: EventActor;

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregate">;
    readonly clock: () => string;
    readonly uuid: () => string;
    readonly actor: EventActor;
  }) {
    this.#journal = options.journal;
    this.#clock = options.clock;
    this.#uuid = options.uuid;
    this.#actor = options.actor;
  }

  /** Keeps the conversation a moved thread carried; called once the thread exists. */
  journalImported(input: {
    readonly threadId: string;
    readonly moveId: string;
    readonly entries: ReadonlyArray<MovedHistoryEntry>;
  }): void {
    if (this.#read(input.threadId).imported !== undefined) return;
    this.#append(input.threadId, THREAD_MOVED_HISTORY_EVENT_NAMES.imported, {
      threadId: input.threadId,
      moveId: input.moveId,
      entries: input.entries,
      importedAt: this.#clock() as UtcTimestamp,
    });
  }

  /** The earlier conversation, if this thread was moved here with one. */
  history(threadId: string): ReadonlyArray<MovedHistoryEntry> | undefined {
    return this.#read(threadId).imported?.entries;
  }

  /**
   * The handoff block, until a turn that carried it was admitted. Read from
   * the journal, so a restart before the first turn still delivers it.
   */
  peekFramedForFirstTurn(threadId: string): FramedExternalContent | undefined {
    const state = this.#read(threadId);
    if (state.imported === undefined || state.delivered) return undefined;
    return { section: "conversation", text: movedHistoryHandoff(state.imported.entries) };
  }

  consumeFramedForFirstTurn(threadId: string): void {
    const state = this.#read(threadId);
    if (state.imported === undefined || state.delivered) return;
    this.#append(threadId, THREAD_MOVED_HISTORY_EVENT_NAMES.delivered, {
      threadId,
      deliveredAt: this.#clock() as UtcTimestamp,
    });
  }

  #read(threadId: string): {
    readonly imported: MovedHistoryImported | undefined;
    readonly delivered: boolean;
  } {
    let events;
    try {
      events = this.#journal.replayAggregate({
        aggregateType: THREAD_MOVED_HISTORY_AGGREGATE,
        aggregateId: threadId,
        afterVersion: 0,
        limit: 10,
      });
    } catch {
      return { imported: undefined, delivered: false };
    }
    let imported: MovedHistoryImported | undefined;
    let delivered = false;
    for (const event of events) {
      if (event.eventName === THREAD_MOVED_HISTORY_EVENT_NAMES.imported) {
        imported = decodeImported(event.payload);
      }
      if (event.eventName === THREAD_MOVED_HISTORY_EVENT_NAMES.delivered) delivered = true;
    }
    return { imported, delivered };
  }

  #append(threadId: string, eventName: string, payload: unknown): void {
    const head = this.#journal
      .replayAggregate({
        aggregateType: THREAD_MOVED_HISTORY_AGGREGATE,
        aggregateId: threadId,
        afterVersion: 0,
        limit: 10,
      })
      .at(-1);
    this.#journal.append({
      aggregate: { aggregateType: THREAD_MOVED_HISTORY_AGGREGATE, aggregateId: threadId },
      expectedVersion: head?.aggregateVersion ?? 0,
      events: [
        {
          eventId: this.#uuid(),
          eventName,
          eventVersion: 1,
          correlationId: this.#uuid(),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload,
        },
      ],
    });
  }
}

/**
 * The handoff a moved thread's first turn reads: a sentence saying where the
 * conversation comes from, then the conversation, newest kept when it is too
 * long, with what was left out named.
 */
export function movedHistoryHandoff(entries: ReadonlyArray<MovedHistoryEntry>): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const line = `${entry.role === "person" ? "Person" : "Assistant"}: ${entry.text}`;
    if (used + line.length > MOVED_HISTORY_HANDOFF_CHARACTERS) {
      omitted = index + 1;
      break;
    }
    lines.unshift(line);
    used += line.length;
  }
  return [
    "This thread was moved here from another of the person's computers. Its earlier conversation there follows, oldest first. The provider's session did not move, so this is the whole of what came before.",
    ...(omitted > 0 ? [`(${String(omitted)} earlier messages are left out for length.)`] : []),
    "",
    ...lines,
  ].join("\n");
}
