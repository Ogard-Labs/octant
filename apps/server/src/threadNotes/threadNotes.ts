import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_THREAD_NOTES,
  THREAD_NOTE_EVENT_NAMES,
  THREAD_NOTES_AGGREGATE_TYPE,
  ThreadNoteAdded,
  ThreadNoteDeleted,
  ThreadNoteEdited,
  decodeThreadNoteAdded,
  decodeThreadNoteDeleted,
  decodeThreadNoteEdited,
  decodeThreadNotesCommand,
  type MentionableThreadId,
  type OctantMode,
  type ThreadMentionTranscriptEntry,
  type ThreadNote,
  type ThreadNotesCommand,
  type ThreadNotesRefusalReason,
  type ThreadNotesResult,
  type WindowId,
} from "@octant/contracts";
import { recapThread } from "@octant/domain";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

type JournalPort = Pick<Journal, "append" | "replayAggregateType">;

export function registerThreadNoteEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(THREAD_NOTE_EVENT_NAMES.added, 1, ThreadNoteAdded)
    .register(THREAD_NOTE_EVENT_NAMES.edited, 1, ThreadNoteEdited)
    .register(THREAD_NOTE_EVENT_NAMES.deleted, 1, ThreadNoteDeleted);
}

/**
 * Notes are the person's own words. A turn's agent, a routine or the host
 * itself journals as `agent` or `system`, and none of them may write, change
 * or remove what the person wrote, so only a person's actor is accepted.
 */
function actsAsPerson(actor: EventActor): boolean {
  return (
    actor.kind === "local-user" || actor.kind === "remote-device" || actor.kind === "owner-unlock"
  );
}

interface ThreadRecord {
  readonly notes: ThreadNote[];
  version: number;
}

/**
 * Each thread's notes, rebuilt from the journal at start. Applying an event
 * replaces or removes a note by id, so replaying the same journal always
 * yields the same notes; the view advances only after an append committed.
 */
export class ThreadNoteStore {
  readonly #journal: JournalPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #records = new Map<string, ThreadRecord>();

  constructor(options: {
    readonly journal: JournalPort;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#hydrate();
  }

  read(threadId: string): ReadonlyArray<ThreadNote> {
    return [...(this.#records.get(threadId)?.notes ?? [])];
  }

  add(threadId: MentionableThreadId, text: string, actor: EventActor): ThreadNoteWrite {
    if (!actsAsPerson(actor)) return refusedWrite("not-the-person");
    const record = this.#record(String(threadId));
    if (record.notes.length >= MAX_THREAD_NOTES) return refusedWrite("too-many-notes");
    const payload = decodeThreadNoteAdded({
      threadId,
      noteId: this.#uuid(),
      text,
      at: this.#clock(),
    });
    this.#append(record, THREAD_NOTE_EVENT_NAMES.added, payload, actor);
    applyAdded(record, payload);
    return { kind: "written" };
  }

  edit(
    threadId: MentionableThreadId,
    noteId: string,
    text: string,
    actor: EventActor,
  ): ThreadNoteWrite {
    if (!actsAsPerson(actor)) return refusedWrite("not-the-person");
    const record = this.#records.get(String(threadId));
    if (record === undefined || !hasNote(record, noteId)) return refusedWrite("note-not-found");
    const payload = decodeThreadNoteEdited({ threadId, noteId, text, at: this.#clock() });
    this.#append(record, THREAD_NOTE_EVENT_NAMES.edited, payload, actor);
    applyEdited(record, payload);
    return { kind: "written" };
  }

  delete(threadId: MentionableThreadId, noteId: string, actor: EventActor): ThreadNoteWrite {
    if (!actsAsPerson(actor)) return refusedWrite("not-the-person");
    const record = this.#records.get(String(threadId));
    if (record === undefined || !hasNote(record, noteId)) return refusedWrite("note-not-found");
    const payload = decodeThreadNoteDeleted({ threadId, noteId, at: this.#clock() });
    this.#append(record, THREAD_NOTE_EVENT_NAMES.deleted, payload, actor);
    applyDeleted(record, payload);
    return { kind: "written" };
  }

  #record(threadId: string): ThreadRecord {
    const existing = this.#records.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadRecord = { notes: [], version: 0 };
    this.#records.set(threadId, created);
    return created;
  }

  #append(record: ThreadRecord, eventName: string, payload: NoteEvent, actor: EventActor): void {
    this.#journal.append({
      aggregate: {
        aggregateType: THREAD_NOTES_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(String(payload.threadId)),
      },
      expectedVersion: decodeAggregateVersion(record.version),
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor,
          occurredAt: payload.at,
          payload,
        },
      ],
    });
    record.version += 1;
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#journal, [
      THREAD_NOTES_AGGREGATE_TYPE,
    ])) {
      const record = this.#record(String(envelope.aggregateId));
      record.version = envelope.aggregateVersion;
      if (envelope.eventName === THREAD_NOTE_EVENT_NAMES.added) {
        applyAdded(record, decodeThreadNoteAdded(envelope.payload));
      } else if (envelope.eventName === THREAD_NOTE_EVENT_NAMES.edited) {
        applyEdited(record, decodeThreadNoteEdited(envelope.payload));
      } else if (envelope.eventName === THREAD_NOTE_EVENT_NAMES.deleted) {
        applyDeleted(record, decodeThreadNoteDeleted(envelope.payload));
      }
    }
  }
}

type NoteEvent = ThreadNoteAdded | ThreadNoteEdited | ThreadNoteDeleted;

export type ThreadNoteWrite =
  | { readonly kind: "written" }
  | { readonly kind: "refused"; readonly reason: ThreadNotesRefusalReason };

function refusedWrite(reason: ThreadNotesRefusalReason): ThreadNoteWrite {
  return { kind: "refused", reason };
}

function hasNote(record: ThreadRecord, noteId: string): boolean {
  return record.notes.some((note) => String(note.id) === String(noteId));
}

function applyAdded(record: ThreadRecord, payload: ThreadNoteAdded): void {
  if (hasNote(record, String(payload.noteId))) return;
  record.notes.push({
    id: payload.noteId,
    text: payload.text,
    createdAt: payload.at,
    updatedAt: payload.at,
  });
}

function applyEdited(record: ThreadRecord, payload: ThreadNoteEdited): void {
  const index = record.notes.findIndex((note) => String(note.id) === String(payload.noteId));
  const note = record.notes[index];
  if (note === undefined) return;
  record.notes[index] = { ...note, text: payload.text, updatedAt: payload.at };
}

function applyDeleted(record: ThreadRecord, payload: ThreadNoteDeleted): void {
  const index = record.notes.findIndex((note) => String(note.id) === String(payload.noteId));
  if (index >= 0) record.notes.splice(index, 1);
}

/** The thread as the window may open it now, with its newest transcript window. */
export type ThreadRecapSourceRead =
  | {
      readonly kind: "readable";
      readonly mode: OctantMode;
      readonly title: string;
      readonly transcript: ReadonlyArray<ThreadMentionTranscriptEntry>;
      readonly truncated: boolean;
    }
  | { readonly kind: "unreadable" };

export interface ThreadNotesServiceOptions {
  readonly store: ThreadNoteStore;
  /**
   * Whether this window may open the thread now. Notes reach exactly the
   * threads the mention and Side Chat paths already resolve, never more.
   */
  readonly canOpen: (windowId: WindowId, threadId: MentionableThreadId) => Promise<boolean>;
  /** The owning mode's own transcript reader, under the same authority. */
  readonly readRecapSource: (
    windowId: WindowId,
    threadId: MentionableThreadId,
  ) => Promise<ThreadRecapSourceRead>;
}

const REFUSAL_MESSAGES: Record<ThreadNotesRefusalReason, string> = {
  "thread-unavailable": "This thread is not available here.",
  "not-the-person": "Only you can write notes on a thread.",
  "note-not-found": "That note is no longer on this thread.",
  "too-many-notes": `A thread keeps up to ${MAX_THREAD_NOTES} notes. Delete one to add another.`,
};

function refused(reason: ThreadNotesRefusalReason): ThreadNotesResult {
  return { kind: "thread-notes-refused", reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * The person's notes on a thread and its recap. Every command is checked
 * against the window's open authority for the thread before anything is read
 * or journaled; the actor comes from the authenticated route, never the body.
 */
export class ThreadNotesService {
  readonly #options: ThreadNotesServiceOptions;

  constructor(options: ThreadNotesServiceOptions) {
    this.#options = options;
  }

  async execute(
    input: unknown,
    context: { readonly windowId: WindowId; readonly actor: EventActor },
  ): Promise<ThreadNotesResult> {
    const command: ThreadNotesCommand = decodeThreadNotesCommand(input);
    const { threadId } = command;
    if (command.kind === "read-thread-recap") return this.#recap(context.windowId, threadId);
    if (!(await this.#options.canOpen(context.windowId, threadId))) {
      return refused("thread-unavailable");
    }
    const store = this.#options.store;
    const write =
      command.kind === "add-thread-note"
        ? store.add(threadId, command.text, context.actor)
        : command.kind === "edit-thread-note"
          ? store.edit(threadId, String(command.noteId), command.text, context.actor)
          : command.kind === "delete-thread-note"
            ? store.delete(threadId, String(command.noteId), context.actor)
            : ({ kind: "written" } as const);
    if (write.kind === "refused") return refused(write.reason);
    return { kind: "thread-notes", threadId, notes: store.read(String(threadId)) };
  }

  async #recap(windowId: WindowId, threadId: MentionableThreadId): Promise<ThreadNotesResult> {
    const source = await this.#options.readRecapSource(windowId, threadId);
    if (source.kind === "unreadable") return refused("thread-unavailable");
    return {
      kind: "thread-recap",
      recap: recapThread({
        threadId,
        mode: source.mode,
        title: source.title,
        transcript: source.transcript,
        truncated: source.truncated,
        notes: this.#options.store.read(String(threadId)).length,
      }),
    };
  }
}
