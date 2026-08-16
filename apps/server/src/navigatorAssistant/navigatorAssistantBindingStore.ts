import { randomUUID } from "node:crypto";
import {
  decodeNavigatorAssistantThreadBound,
  NAVIGATOR_ASSISTANT_EVENT_NAMES,
  type ChatThreadId,
  type EventEnvelope,
  type NavigatorAssistantThreadBound,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";

export const NAVIGATOR_ASSISTANT_AGGREGATE_TYPE = "navigator-assistant";

/**
 * Navigator is one conversation per host and the journal is one host's, so the
 * binding is a singleton aggregate with a fixed id. Appending at expected
 * version 0 is therefore the durable "at most one Navigator conversation"
 * guard, enforced by the journal rather than by an in-memory flag a restart
 * would forget.
 */
export const NAVIGATOR_ASSISTANT_AGGREGATE_ID = "00000000-0000-4000-8000-000000000930";

/**
 * Navigator binds its conversation through the loopback Navigator API, which
 * authenticates a window rather than a journal principal, so the durable write
 * is attributed to the Navigator service itself.
 */
const NAVIGATOR_ASSISTANT_ACTOR = {
  kind: "system",
  actorId: "00000000-0000-4000-8000-000000000930",
} as const;

const REPLAY_BATCH_SIZE = 1_000;

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

/** The one host-owned Navigator conversation binding. */
export interface NavigatorAssistantBindingStore {
  /** The bound Navigator conversation, or `undefined` before first use. */
  read(): ChatThreadId | undefined;
  /**
   * Bind a thread as this host's Navigator conversation. Returns the binding
   * that is now authoritative: an existing binding always wins, so a racing
   * second bind adopts the first conversation instead of replacing it.
   */
  bind(input: { readonly threadId: ChatThreadId; readonly boundAt: string }): ChatThreadId;
  /**
   * The bound Navigator thread id, for the Chat hidden-thread seam. The
   * Navigator conversation is an ordinary Chat thread that must never appear
   * in Recents, Unfiled, Project nesting, search, or the mention picker.
   */
  hiddenThreadIds(): ReadonlySet<string>;
}

export class NavigatorAssistantBindingStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigatorAssistantBindingStoreError";
  }
}

export interface JournalNavigatorAssistantBindingStoreOptions {
  readonly journal: JournalPort;
  readonly uuid?: () => string;
}

/**
 * Durable Navigator binding backed by the authoritative event journal.
 *
 * Binding the conversation appends one `navigator-assistant.thread-bound@1`
 * event. Construction rebuilds the binding by replaying that aggregate type,
 * which is why the Navigator conversation and its whole transcript survive a
 * host restart instead of the host minting a second, empty one.
 *
 * Applying a replayed event is idempotent: the first binding wins and later
 * events are ignored, so replaying the journal any number of times produces
 * identical state. The in-memory view advances only after the append commits,
 * so a failed write leaves the journal and the served binding on the same
 * durable state.
 */
export class JournalNavigatorAssistantBindingStore implements NavigatorAssistantBindingStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  #threadId: ChatThreadId | undefined;

  constructor(options: JournalNavigatorAssistantBindingStoreOptions) {
    this.#journal = options.journal;
    this.#uuid = options.uuid ?? randomUUID;
    this.#rebuild();
  }

  read(): ChatThreadId | undefined {
    return this.#threadId;
  }

  bind(input: { readonly threadId: ChatThreadId; readonly boundAt: string }): ChatThreadId {
    if (this.#threadId !== undefined) return this.#threadId;

    let payload: NavigatorAssistantThreadBound;
    try {
      payload = decodeNavigatorAssistantThreadBound({
        threadId: input.threadId,
        boundAt: input.boundAt,
      });
    } catch {
      throw new NavigatorAssistantBindingStoreError("Navigator binding is not durable.");
    }

    try {
      this.#journal.append({
        aggregate: {
          aggregateType: NAVIGATOR_ASSISTANT_AGGREGATE_TYPE,
          aggregateId: NAVIGATOR_ASSISTANT_AGGREGATE_ID,
        },
        expectedVersion: 0,
        events: [
          {
            eventId: this.#uuid(),
            eventName: NAVIGATOR_ASSISTANT_EVENT_NAMES.threadBound,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: NAVIGATOR_ASSISTANT_ACTOR,
            occurredAt: payload.boundAt,
            payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        // Another writer bound the Navigator conversation first. The durable
        // binding is authoritative, so adopt it rather than failing: the
        // caller asked for *the* Navigator conversation.
        this.#rebuild();
        if (this.#threadId !== undefined) return this.#threadId;
      }
      throw new NavigatorAssistantBindingStoreError("Navigator binding could not be saved.");
    }
    this.#apply(payload);
    return payload.threadId;
  }

  hiddenThreadIds(): ReadonlySet<string> {
    return this.#threadId === undefined ? EMPTY : new Set([String(this.#threadId)]);
  }

  #rebuild(): void {
    let afterSequence = 0;
    for (;;) {
      const batch = this.#journal.replayAggregateType({
        aggregateType: NAVIGATOR_ASSISTANT_AGGREGATE_TYPE,
        afterSequence,
        limit: REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) return;
      for (const envelope of batch) {
        afterSequence = envelope.globalSequence;
        this.#apply(decodeEnvelope(envelope));
      }
      if (batch.length < REPLAY_BATCH_SIZE) return;
    }
  }

  #apply(payload: NavigatorAssistantThreadBound): void {
    if (this.#threadId !== undefined) return;
    this.#threadId = payload.threadId;
  }
}

const EMPTY: ReadonlySet<string> = new Set();

function decodeEnvelope(envelope: EventEnvelope): NavigatorAssistantThreadBound {
  if (
    envelope.eventName !== NAVIGATOR_ASSISTANT_EVENT_NAMES.threadBound ||
    envelope.eventVersion !== 1 ||
    envelope.aggregateType !== NAVIGATOR_ASSISTANT_AGGREGATE_TYPE
  ) {
    throw new NavigatorAssistantBindingStoreError(
      "Journaled Navigator event is not a thread binding.",
    );
  }
  try {
    return decodeNavigatorAssistantThreadBound(envelope.payload);
  } catch {
    throw new NavigatorAssistantBindingStoreError("Journaled Navigator event payload is invalid.");
  }
}
