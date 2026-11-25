import { createHash } from "node:crypto";
import {
  THREAD_RETENTION_EVENT_NAMES,
  decodeChatDeleted,
  decodeThreadRetentionThreadPurged,
  type CommittedAppend,
  type EventActor,
  type OctantMode,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  DEFAULT_PERSON_MEMORY_SETTINGS,
  PERSON_MEMORY_ENTRY_AGGREGATE_TYPE,
  PERSON_MEMORY_ENTRY_RECORDED,
  PERSON_MEMORY_ENTRY_SAVED,
  PERSON_MEMORY_SETTINGS_AGGREGATE_TYPE,
  PERSON_MEMORY_SETTINGS_CHANGED,
  PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
  PERSON_MEMORY_THREAD_REMEMBERED,
  PERSON_MEMORY_THREAD_UNTRACED,
  PERSON_MEMORY_TURN_TYPED,
  PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
  PERSON_MEMORY_MAX_TYPED_TURNS_PER_THREAD,
  PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
  PersonMemoryEntryRecorded,
  PersonMemoryEntrySaved,
  PersonMemorySettingsChanged,
  PersonMemoryThreadRemembered,
  PersonMemoryThreadUntraced,
  PersonMemoryTurnTyped,
  decodePersonMemoryResult,
  type PersonMemoryCommand,
  type PersonMemoryEntry,
  type PersonMemoryKind,
  type PersonMemoryRefusalReason,
  type PersonMemoryResult,
  type PersonMemorySettings,
  type PersonMemorySource,
  type PersonMemoryThreadDigest,
  type PersonMemoryThreadRef,
  type PersonMemoryUntracedThread,
  type PersonMemoryView,
} from "@octant/contracts/person-memory";
import {
  mergePersonMemory,
  personMemoryBlockText,
  personMemoryEntryShown,
  sameThread,
  searchPastThreads,
  type PastThreadHit,
  type PersonMemoryWithheld,
} from "@octant/domain/person-memory-policy";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { replayAggregateTypesInOrder } from "../persistence/journalHydration";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  clampCheckpointsToJournalHead,
  deleteJournalEvents,
  reconcileAggregateHeads,
} from "../persistence/threadPurge";

/** The one aggregate the person's memory settings live in. */
const SETTINGS_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000e1";

const decodeSettingsChanged = Schema.decodeUnknownSync(PersonMemorySettingsChanged);
const decodeEntryRecorded = Schema.decodeUnknownSync(PersonMemoryEntryRecorded);
const decodeEntrySaved = Schema.decodeUnknownSync(PersonMemoryEntrySaved);
const decodeThreadRemembered = Schema.decodeUnknownSync(PersonMemoryThreadRemembered);
const decodeThreadUntraced = Schema.decodeUnknownSync(PersonMemoryThreadUntraced);
const decodeTurnTyped = Schema.decodeUnknownSync(PersonMemoryTurnTyped);

export function registerPersonMemoryEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PERSON_MEMORY_SETTINGS_CHANGED, 1, PersonMemorySettingsChanged)
    .register(PERSON_MEMORY_ENTRY_RECORDED, 1, PersonMemoryEntryRecorded)
    .register(PERSON_MEMORY_ENTRY_SAVED, 1, PersonMemoryEntrySaved)
    .register(PERSON_MEMORY_THREAD_REMEMBERED, 1, PersonMemoryThreadRemembered)
    .register(PERSON_MEMORY_THREAD_UNTRACED, 1, PersonMemoryThreadUntraced)
    .register(PERSON_MEMORY_TURN_TYPED, 1, PersonMemoryTurnTyped);
}

/** A stable aggregate id for one thread's digest or mark, from its mode and id. */
export function personMemoryThreadAggregateId(
  kind: string,
  thread: { readonly mode: string; readonly threadId: string },
): string {
  const hash = createHash("sha1")
    .update(`octant:person-memory:${kind}\0`)
    .update(thread.mode)
    .update("\0")
    .update(String(thread.threadId))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** The thread a new turn belongs to, as person memory needs to know it. */
export interface PersonMemoryThreadScope {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly createdAt: string;
}

/** What saving the person's own words at once did; a refusal says why, for the model to read. */
export type PersonMemorySaveOutcome =
  | { readonly status: "saved"; readonly created: boolean }
  | {
      readonly status: "refused";
      readonly reason: "memory-off" | "project-kept-out" | "leaves-no-trace";
    };

export interface PersonMemoryStoreDependencies {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "subscribeCommitted">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: EventActor;
}

/**
 * Person memory on this host: settings, entries, one digest per remembered
 * thread, and the threads marked to leave no trace. All of it is journaled
 * and rebuilt from the journal at start. An entry's aggregate always holds
 * exactly its current state: an edit, a lost source, or a delete erases the
 * old events first, so text the person removed does not stay in history.
 */
export class PersonMemoryStore {
  readonly #dependencies: PersonMemoryStoreDependencies;
  #settings: PersonMemorySettings = DEFAULT_PERSON_MEMORY_SETTINGS;
  #since: UtcTimestamp | undefined;
  #typedSince: UtcTimestamp | undefined;
  #settingsVersion = 0;
  readonly #entries = new Map<string, PersonMemoryEntry>();
  readonly #digests = new Map<string, PersonMemoryThreadDigest>();
  readonly #untraced = new Map<string, PersonMemoryUntracedThread & { readonly version: number }>();
  /** Entries first kept at once from an open thread; a rewrite keeps that event. */
  readonly #savedEntryIds = new Set<string>();
  /** Per thread, the ids of the turns the person typed, oldest first. */
  readonly #typedTurns = new Map<string, string[]>();
  /**
   * Threads purged, deleted, or marked to leave no trace while this host ran.
   * A distillation already waiting on its model call for one of them must
   * not write what it learned once the thread's memory was erased.
   */
  readonly #gone = new Set<string>();
  readonly #unsubscribe: () => void;

  constructor(dependencies: PersonMemoryStoreDependencies) {
    this.#dependencies = dependencies;
    this.#hydrate();
    this.#unsubscribe = dependencies.journal.subscribeCommitted((append) =>
      this.#onCommitted(append),
    );
  }

  close(): void {
    this.#unsubscribe();
  }

  settings(): PersonMemorySettings {
    return this.#settings;
  }

  /**
   * When memory began on this host; threads completed earlier are never
   * distilled. The first sweep records it, so turning memory on (or
   * upgrading to it) never back-fills a host's whole history.
   */
  since(): UtcTimestamp {
    if (this.#since === undefined) this.#writeSettings(this.#settings);
    return this.#since ?? this.#dependencies.clock();
  }

  /**
   * When this host began recording which turns the person typed, journaled in
   * the settings so it survives replay and Forget everything. The host asks at
   * start, so every turn that begins later is either marked or not the
   * person's words; a turn that began earlier is read as it always was.
   */
  typedSince(): UtcTimestamp {
    if (this.#typedSince === undefined) this.#writeSettings(this.#settings);
    return this.#typedSince ?? this.#dependencies.clock();
  }

  /**
   * Records that the person typed a turn's message into a composer (or a
   * steered message into a running turn). Only the person's own route may call
   * this. A thread that takes no part in memory is marked nothing; a mark
   * already there is not written again.
   */
  markTurnTyped(input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly turnId: string;
    readonly projectId?: string | undefined;
  }): void {
    const thread = { mode: input.mode, threadId: input.threadId };
    if (!this.threadTakesPart({ ...thread, projectId: input.projectId })) return;
    if (this.#gone.has(threadKey(thread))) return;
    if (this.isTurnTyped(input)) return;
    this.typedSince();
    try {
      this.#append(
        PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
        personMemoryThreadAggregateId(`typed:${input.turnId}`, thread),
        0,
        PERSON_MEMORY_TURN_TYPED,
        { threadId: input.threadId, mode: input.mode, turnId: input.turnId },
      );
    } catch (error) {
      if (error instanceof ConcurrencyConflict) return;
      throw error;
    }
    this.#rememberTyped(thread, input.turnId);
  }

  isTurnTyped(input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly turnId: string;
  }): boolean {
    return this.#typedTurns.get(threadKey(input))?.includes(input.turnId) === true;
  }

  /** The marked turn ids of a thread, for a reader that picks the person's words out of a thread. */
  typedTurnIds(thread: {
    readonly mode: OctantMode;
    readonly threadId: string;
  }): ReadonlySet<string> {
    return new Set(this.#typedTurns.get(threadKey(thread)));
  }

  /**
   * Whether a turn's message counts as the person's own words for learning:
   * the host marked it typed, or it began before this host began recording
   * marks and is read as it always was. A turn that began after and carries no
   * mark (a side task, a delivery, a button's text, an older client's send) is
   * not the person's.
   */
  countsAsPersonWords(turn: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly turnId: string;
    readonly began: string;
  }): boolean {
    return this.isTurnTyped(turn) || turn.began < this.typedSince();
  }

  #rememberTyped(thread: { readonly mode: string; readonly threadId: string }, turnId: string) {
    const key = threadKey(thread);
    const turns = this.#typedTurns.get(key) ?? [];
    turns.push(turnId);
    this.#typedTurns.set(key, turns);
    while (turns.length > PERSON_MEMORY_MAX_TYPED_TURNS_PER_THREAD) {
      const oldest = turns.shift();
      if (oldest === undefined) break;
      this.#erase([
        {
          aggregateType: PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
          aggregateId: personMemoryThreadAggregateId(`typed:${oldest}`, thread),
        },
      ]);
    }
  }

  #eraseTyped(thread: { readonly mode: string; readonly threadId: string }): void {
    const turns = this.#typedTurns.get(threadKey(thread));
    if (turns === undefined) return;
    this.#typedTurns.delete(threadKey(thread));
    this.#erase(
      turns.map((turnId) => ({
        aggregateType: PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
        aggregateId: personMemoryThreadAggregateId(`typed:${turnId}`, thread),
      })),
    );
  }

  view(): PersonMemoryView {
    return {
      kind: "person-memory",
      settings: this.#settings,
      version: this.#settingsVersion,
      entries: [...this.#entries.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
      rememberedThreads: this.#digests.size,
      untracedThreads: [...this.#untraced.values()]
        .map(({ version: _version, ...thread }) => thread)
        .sort((left, right) => right.markedAt.localeCompare(left.markedAt)),
    };
  }

  isRemembered(thread: PersonMemoryThreadRef): boolean {
    return this.#digests.has(threadKey(thread));
  }

  leavesNoTrace(thread: { readonly mode: OctantMode; readonly threadId: string }): boolean {
    return this.#untraced.has(threadKey(thread));
  }

  projectExcluded(projectId: string | undefined): boolean {
    return (
      projectId !== undefined && this.#settings.excludedProjectIds.some((id) => id === projectId)
    );
  }

  /** Whether a thread takes part in memory at all: read from, written from, or searched in. */
  threadTakesPart(scope: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId?: string | undefined;
  }): boolean {
    return (
      this.#settings.enabled && !this.projectExcluded(scope.projectId) && !this.leavesNoTrace(scope)
    );
  }

  /** The person-memory block for a thread's turn, or `undefined` when it gets none. */
  blockFor(scope: PersonMemoryThreadScope): string | undefined {
    if (!this.threadTakesPart(scope)) return undefined;
    return personMemoryBlockText({
      entries: [...this.#entries.values()],
      threadCreatedAt: scope.createdAt,
      withheld: this.#withheld(),
    });
  }

  /** Whether a thread is offered the past-threads tool. */
  searchOffered(scope: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId?: string | undefined;
  }): boolean {
    return this.threadTakesPart(scope) && this.#settings.pastThreadSearch;
  }

  search(
    scope: {
      readonly mode: OctantMode;
      readonly threadId: string;
      readonly projectId?: string | undefined;
    },
    query: string,
  ): ReadonlyArray<PastThreadHit> | undefined {
    if (!this.searchOffered(scope)) return undefined;
    return searchPastThreads({
      query,
      digests: [...this.#digests.values()],
      entries: [...this.#entries.values()],
      withheld: this.#withheld(),
      exclude: { mode: scope.mode, threadId: scope.threadId },
    });
  }

  knownEntries(): ReadonlyArray<string> {
    // Only what other threads may see: an entry learned only in a Project kept
    // out, or a thread that leaves no trace, must not reach another provider.
    const withheld = this.#withheld();
    return [...this.#entries.values()]
      .filter((entry) => personMemoryEntryShown(entry, withheld))
      .map((entry) => entry.content);
  }

  /**
   * Records what one ended thread taught: its digest, new entries, and new
   * sources on entries learned again. Nothing is written for a thread that
   * was remembered already or no longer takes part.
   */
  remember(input: {
    readonly source: PersonMemorySource;
    readonly summary: string;
    readonly entries: ReadonlyArray<{ readonly kind: PersonMemoryKind; readonly content: string }>;
  }): "remembered" | "skipped" {
    const thread = { mode: input.source.mode, threadId: input.source.threadId };
    if (this.isRemembered(thread)) return "skipped";
    // The answer may arrive after the person forgot everything, switched
    // memory off and on, or erased this thread: it then stays unwritten.
    if (this.#gone.has(threadKey(thread))) return "skipped";
    if (this.#since !== undefined && input.source.endedAt < this.#since) return "skipped";
    if (!this.threadTakesPart({ ...thread, projectId: input.source.projectId })) return "skipped";
    const digest: PersonMemoryThreadDigest = { source: input.source, summary: input.summary };
    try {
      this.#append(
        PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
        personMemoryThreadAggregateId("thread", thread),
        0,
        PERSON_MEMORY_THREAD_REMEMBERED,
        { threadId: input.source.threadId, digest },
      );
    } catch (error) {
      if (error instanceof ConcurrencyConflict) return "skipped";
      throw error;
    }
    this.#digests.set(threadKey(thread), digest);
    const merged = mergePersonMemory({
      existing: [...this.#entries.values()],
      distilled: input.entries,
      source: input.source,
      now: this.#dependencies.clock(),
      newId: () => this.#dependencies.uuid() as PersonMemoryEntry["id"],
    });
    for (const entry of merged.recorded) this.#writeEntry(entry);
    for (const entry of merged.evicted) this.#eraseEntry(String(entry.id));
    return "remembered";
  }

  /** Why a thread may not save an entry now; `undefined` when it may. */
  saveRefusal(scope: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId?: string | undefined;
  }): "memory-off" | "project-kept-out" | "leaves-no-trace" | undefined {
    if (!this.#settings.enabled) return "memory-off";
    if (this.projectExcluded(scope.projectId)) return "project-kept-out";
    if (this.leavesNoTrace(scope) || this.#gone.has(threadKey(scope))) return "leaves-no-trace";
    return undefined;
  }

  /**
   * Keeps one entry the person asked for in their own words, from a thread that
   * has not ended. Unlike `remember` it writes no digest and does not mark the
   * thread remembered, so the sweep still learns from the thread when it ends;
   * an entry learned again from it then only keeps its one source. The caller
   * has already shown the text is the person's own words.
   */
  saveFromOpenThread(input: {
    /** The open thread; the entry records when the person said it as the source's `endedAt`. */
    readonly source: Omit<PersonMemorySource, "endedAt">;
    readonly kind: PersonMemoryKind;
    readonly content: string;
  }): PersonMemorySaveOutcome {
    const refusal = this.saveRefusal(input.source);
    if (refusal !== undefined) return { status: "refused", reason: refusal };
    const now = this.#dependencies.clock();
    const merged = mergePersonMemory({
      existing: [...this.#entries.values()],
      distilled: [{ kind: input.kind, content: input.content }],
      source: { ...input.source, endedAt: now },
      now,
      newId: () => this.#dependencies.uuid() as PersonMemoryEntry["id"],
    });
    const created = merged.recorded.some((entry) => !this.#entries.has(String(entry.id)));
    for (const entry of merged.recorded) {
      this.#writeEntry(entry, undefined, PERSON_MEMORY_ENTRY_SAVED);
    }
    for (const entry of merged.evicted) this.#eraseEntry(String(entry.id));
    return { status: "saved", created };
  }

  /**
   * `actor` is who asked, as the route resolved it from the authenticated
   * principal: a paired device's change is journaled as that device. Absent
   * means the person at this host.
   */
  change(command: PersonMemoryCommand, actor?: EventActor): PersonMemoryResult {
    switch (command.kind) {
      case "change-person-memory-settings":
        if (command.expectedVersion !== this.#settingsVersion) {
          return refused("stale-version", "Memory settings changed since you read them.");
        }
        this.#writeSettings(
          command.settings,
          widensMemory(this.#settings, command.settings) ? "restart" : "keep",
          actor,
        );
        return this.view();
      case "edit-person-memory-entry": {
        const entry = this.#entries.get(String(command.entryId));
        if (entry === undefined) return refused("not-found", "That memory is already gone.");
        const now = this.#dependencies.clock();
        this.#writeEntry(
          { ...entry, content: command.content, editedAt: now, updatedAt: now },
          actor,
        );
        return this.view();
      }
      case "delete-person-memory-entry":
        if (!this.#entries.has(String(command.entryId))) {
          return refused("not-found", "That memory is already gone.");
        }
        this.#eraseEntry(String(command.entryId));
        return this.view();
      case "forget-person-memory":
        this.#forgetEverything(actor);
        return this.view();
      case "set-thread-leaves-no-trace":
        this.#markThread(command, actor);
        return this.view();
    }
  }

  #withheld(): PersonMemoryWithheld {
    return {
      excludedProjectIds: this.#settings.excludedProjectIds.map(String),
      untraced: [...this.#untraced.values()],
    };
  }

  #markThread(
    command: Extract<PersonMemoryCommand, { readonly kind: "set-thread-leaves-no-trace" }>,
    actor: EventActor | undefined,
  ): void {
    const thread = { mode: command.mode, threadId: command.threadId };
    const key = threadKey(thread);
    const current = this.#untraced.get(key);
    if (command.leavesNoTrace === (current !== undefined)) return;
    const aggregateId = personMemoryThreadAggregateId("untraced", thread);
    const version =
      current?.version ??
      readVersion(
        this.#dependencies.connection,
        PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
        aggregateId,
      );
    const envelope = this.#append(
      PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
      aggregateId,
      version,
      PERSON_MEMORY_THREAD_UNTRACED,
      {
        threadId: command.threadId,
        mode: command.mode,
        ...(command.title === undefined ? {} : { title: command.title }),
        leavesNoTrace: command.leavesNoTrace,
      },
      actor,
    );
    if (!command.leavesNoTrace) {
      this.#untraced.delete(key);
      this.#writeSettings(this.#settings, "restart", actor);
      return;
    }
    this.#untraced.set(key, {
      mode: command.mode,
      threadId: command.threadId,
      ...(command.title === undefined ? {} : { title: command.title }),
      markedAt: envelope.occurredAt,
      version: envelope.version,
    });
    // Marking a thread erases what was already remembered from it.
    this.#gone.add(key);
    this.#forgetThread(thread, actor);
  }

  #forgetThread(
    thread: PersonMemoryThreadRef | { readonly mode: OctantMode; readonly threadId: string },
    actor?: EventActor,
  ): void {
    const key = threadKey(thread);
    this.#eraseTyped(thread);
    if (this.#digests.delete(key)) {
      this.#erase([
        {
          aggregateType: PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
          aggregateId: personMemoryThreadAggregateId("thread", {
            mode: thread.mode,
            threadId: thread.threadId,
          }),
        },
      ]);
    }
    // Rewriting or erasing an entry only replaces or removes keys already
    // visited, which a Map iteration allows.
    for (const entry of this.#entries.values()) {
      if (!entry.sources.some((source) => sameThread(source, thread))) continue;
      const sources = entry.sources.filter((source) => !sameThread(source, thread));
      const [first, ...rest] = sources;
      if (first === undefined) this.#eraseEntry(String(entry.id));
      else
        this.#writeEntry(
          {
            ...entry,
            sources: [first, ...rest],
            updatedAt: this.#dependencies.clock(),
          },
          actor,
        );
    }
  }

  #forgetEverything(actor: EventActor | undefined): void {
    const aggregates = [
      ...[...this.#entries.keys()].map((id) => ({
        aggregateType: PERSON_MEMORY_ENTRY_AGGREGATE_TYPE,
        aggregateId: id,
      })),
      ...[...this.#digests.values()].map((digest) => ({
        aggregateType: PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
        aggregateId: personMemoryThreadAggregateId("thread", digest.source),
      })),
    ];
    const typed = [...this.#typedTurns.entries()].flatMap(([key, turnIds]) => {
      const separator = key.indexOf(":");
      const thread = { mode: key.slice(0, separator), threadId: key.slice(separator + 1) };
      return turnIds.map((turnId) => ({
        aggregateType: PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
        aggregateId: personMemoryThreadAggregateId(`typed:${turnId}`, thread),
      }));
    });
    this.#erase([...aggregates, ...typed]);
    this.#entries.clear();
    this.#digests.clear();
    this.#typedTurns.clear();
    this.#savedEntryIds.clear();
    this.#writeSettings(this.#settings, "restart", actor);
  }

  /**
   * `restart` moves the start of memory to now. Forgetting, switching memory
   * back on, letting a Project back in, or allowing a thread again must not
   * learn from what ended while it was off, kept out, or just forgotten.
   */
  #writeSettings(
    settings: PersonMemorySettings,
    boundary: "keep" | "restart" = "keep",
    actor?: EventActor,
  ): void {
    const since =
      boundary === "restart"
        ? this.#dependencies.clock()
        : (this.#since ?? this.#dependencies.clock());
    // Journaled by the first write that follows start, so a turn that begins
    // after it is either marked or not the person's.
    const typedSince = this.#typedSince ?? this.#dependencies.clock();
    const envelope = this.#append(
      PERSON_MEMORY_SETTINGS_AGGREGATE_TYPE,
      SETTINGS_AGGREGATE_ID,
      this.#settingsVersion,
      PERSON_MEMORY_SETTINGS_CHANGED,
      { settings, since, typedSince },
      actor,
    );
    this.#settings = settings;
    this.#since = since;
    this.#typedSince = typedSince;
    this.#settingsVersion = envelope.version;
  }

  /** Replaces an entry's whole history with one event naming its current state. */
  #writeEntry(
    entry: PersonMemoryEntry,
    actor?: EventActor,
    creation:
      | typeof PERSON_MEMORY_ENTRY_RECORDED
      | typeof PERSON_MEMORY_ENTRY_SAVED = PERSON_MEMORY_ENTRY_RECORDED,
  ): void {
    const aggregate = {
      aggregateType: PERSON_MEMORY_ENTRY_AGGREGATE_TYPE,
      aggregateId: String(entry.id),
    };
    const known = this.#entries.has(String(entry.id));
    if (known) this.#erase([aggregate]);
    // A rewrite keeps the event the entry was first kept with, so the journal
    // still shows which entries the person asked for.
    const eventName = known
      ? this.#savedEntryIds.has(String(entry.id))
        ? PERSON_MEMORY_ENTRY_SAVED
        : PERSON_MEMORY_ENTRY_RECORDED
      : creation;
    this.#append(aggregate.aggregateType, aggregate.aggregateId, 0, eventName, { entry }, actor);
    this.#entries.set(String(entry.id), entry);
    if (eventName === PERSON_MEMORY_ENTRY_SAVED) this.#savedEntryIds.add(String(entry.id));
  }

  #eraseEntry(id: string): void {
    this.#savedEntryIds.delete(id);
    this.#erase([{ aggregateType: PERSON_MEMORY_ENTRY_AGGREGATE_TYPE, aggregateId: id }]);
    this.#entries.delete(id);
  }

  #erase(
    aggregates: ReadonlyArray<{ readonly aggregateType: string; readonly aggregateId: string }>,
  ): void {
    if (aggregates.length === 0) return;
    const { connection } = this.#dependencies;
    connection.pragma("foreign_keys = OFF");
    try {
      connection.transaction(() => {
        deleteJournalEvents(connection, aggregates);
        reconcileAggregateHeads(connection);
        // Erasing the newest events would otherwise leave projection
        // checkpoints past the journal head, which recovery reads as damage.
        clampCheckpointsToJournalHead(connection);
      })();
    } finally {
      connection.pragma("foreign_keys = ON");
    }
  }

  #append(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
    // What the host's own sweep learns names nobody and keeps the store's
    // actor; a person's change names who asked.
    actor: EventActor = this.#dependencies.actor,
  ): { readonly version: number; readonly occurredAt: UtcTimestamp } {
    const occurredAt = this.#dependencies.clock();
    const committed = this.#dependencies.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor,
          occurredAt,
          payload,
        },
      ],
    });
    return { version: committed.aggregateVersion, occurredAt };
  }

  /**
   * A purged or deleted thread takes with it everything remembered only from
   * it. The purge already erased the thread's digest and mark (both name it as
   * `threadId`); entries name it only among their sources, so they are
   * rewritten here.
   */
  #onCommitted(append: CommittedAppend): void {
    for (const event of append.events) {
      let thread: { readonly mode: OctantMode; readonly threadId: string } | undefined;
      if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
        const purged = decodeThreadRetentionThreadPurged(event.payload);
        thread = { mode: purged.mode, threadId: String(purged.threadId) };
      } else if (event.eventName === "chat.deleted@1") {
        thread = { mode: "chat", threadId: String(decodeChatDeleted(event.payload).threadId) };
      }
      if (thread === undefined) continue;
      this.#gone.add(threadKey(thread));
      // A purge already took the mark (it names the thread as `threadId`); a
      // plain delete did not, and the mark carries the thread's title.
      if (this.#untraced.delete(threadKey(thread))) {
        this.#erase([
          {
            aggregateType: PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
            aggregateId: personMemoryThreadAggregateId("untraced", {
              mode: thread.mode,
              threadId: thread.threadId,
            }),
          },
        ]);
      }
      this.#forgetThread(thread);
    }
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#dependencies.journal, [
      PERSON_MEMORY_SETTINGS_AGGREGATE_TYPE,
      PERSON_MEMORY_ENTRY_AGGREGATE_TYPE,
      PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
      PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
      PERSON_MEMORY_TYPED_AGGREGATE_TYPE,
    ])) {
      switch (envelope.eventName) {
        case PERSON_MEMORY_SETTINGS_CHANGED: {
          const changed = decodeSettingsChanged(envelope.payload);
          this.#settings = changed.settings;
          this.#since = changed.since;
          this.#typedSince = changed.typedSince;
          this.#settingsVersion = envelope.aggregateVersion;
          break;
        }
        case PERSON_MEMORY_ENTRY_RECORDED: {
          const { entry } = decodeEntryRecorded(envelope.payload);
          this.#entries.set(String(entry.id), entry);
          break;
        }
        case PERSON_MEMORY_ENTRY_SAVED: {
          const { entry } = decodeEntrySaved(envelope.payload);
          this.#entries.set(String(entry.id), entry);
          this.#savedEntryIds.add(String(entry.id));
          break;
        }
        case PERSON_MEMORY_THREAD_REMEMBERED: {
          const { digest } = decodeThreadRemembered(envelope.payload);
          this.#digests.set(threadKey(digest.source), digest);
          break;
        }
        case PERSON_MEMORY_TURN_TYPED: {
          const typed = decodeTurnTyped(envelope.payload);
          const thread = { mode: typed.mode, threadId: String(typed.threadId) };
          if (!this.isTurnTyped({ ...thread, turnId: typed.turnId })) {
            const turns = this.#typedTurns.get(threadKey(thread)) ?? [];
            turns.push(typed.turnId);
            this.#typedTurns.set(threadKey(thread), turns);
          }
          break;
        }
        case PERSON_MEMORY_THREAD_UNTRACED: {
          const mark = decodeThreadUntraced(envelope.payload);
          const key = threadKey(mark);
          if (!mark.leavesNoTrace) {
            this.#untraced.delete(key);
            break;
          }
          this.#untraced.set(key, {
            mode: mark.mode,
            threadId: mark.threadId,
            ...(mark.title === undefined ? {} : { title: mark.title }),
            markedAt: envelope.occurredAt,
            version: envelope.aggregateVersion,
          });
          break;
        }
      }
    }
  }
}

function threadKey(thread: { readonly mode: string; readonly threadId: string }): string {
  return `${thread.mode}:${String(thread.threadId)}`;
}

function readVersion(
  connection: SqliteConnection,
  aggregateType: string,
  aggregateId: string,
): number {
  const row = connection
    .prepare(
      `SELECT aggregate_version FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?`,
    )
    .get(aggregateType, aggregateId) as { readonly aggregate_version: number } | undefined;
  return row?.aggregate_version ?? 0;
}

function refused(reason: PersonMemoryRefusalReason, message: string): PersonMemoryResult {
  return decodePersonMemoryResult({ kind: "person-memory-refused", reason, message });
}

/** Whether a change lets memory learn from more than before. */
function widensMemory(before: PersonMemorySettings, after: PersonMemorySettings): boolean {
  if (!before.enabled && after.enabled) return true;
  const kept = new Set(after.excludedProjectIds.map(String));
  return before.excludedProjectIds.some((id) => !kept.has(String(id)));
}
