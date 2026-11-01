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
  PERSON_MEMORY_SETTINGS_AGGREGATE_TYPE,
  PERSON_MEMORY_SETTINGS_CHANGED,
  PERSON_MEMORY_THREAD_AGGREGATE_TYPE,
  PERSON_MEMORY_THREAD_REMEMBERED,
  PERSON_MEMORY_THREAD_UNTRACED,
  PERSON_MEMORY_UNTRACED_AGGREGATE_TYPE,
  PersonMemoryEntryRecorded,
  PersonMemorySettingsChanged,
  PersonMemoryThreadRemembered,
  PersonMemoryThreadUntraced,
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
const decodeThreadRemembered = Schema.decodeUnknownSync(PersonMemoryThreadRemembered);
const decodeThreadUntraced = Schema.decodeUnknownSync(PersonMemoryThreadUntraced);

export function registerPersonMemoryEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PERSON_MEMORY_SETTINGS_CHANGED, 1, PersonMemorySettingsChanged)
    .register(PERSON_MEMORY_ENTRY_RECORDED, 1, PersonMemoryEntryRecorded)
    .register(PERSON_MEMORY_THREAD_REMEMBERED, 1, PersonMemoryThreadRemembered)
    .register(PERSON_MEMORY_THREAD_UNTRACED, 1, PersonMemoryThreadUntraced);
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
  #settingsVersion = 0;
  readonly #entries = new Map<string, PersonMemoryEntry>();
  readonly #digests = new Map<string, PersonMemoryThreadDigest>();
  readonly #untraced = new Map<string, PersonMemoryUntracedThread & { readonly version: number }>();
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

  change(command: PersonMemoryCommand): PersonMemoryResult {
    switch (command.kind) {
      case "change-person-memory-settings":
        if (command.expectedVersion !== this.#settingsVersion) {
          return refused("stale-version", "Memory settings changed since you read them.");
        }
        this.#writeSettings(
          command.settings,
          widensMemory(this.#settings, command.settings) ? "restart" : "keep",
        );
        return this.view();
      case "edit-person-memory-entry": {
        const entry = this.#entries.get(String(command.entryId));
        if (entry === undefined) return refused("not-found", "That memory is already gone.");
        const now = this.#dependencies.clock();
        this.#writeEntry({ ...entry, content: command.content, editedAt: now, updatedAt: now });
        return this.view();
      }
      case "delete-person-memory-entry":
        if (!this.#entries.has(String(command.entryId))) {
          return refused("not-found", "That memory is already gone.");
        }
        this.#eraseEntry(String(command.entryId));
        return this.view();
      case "forget-person-memory":
        this.#forgetEverything();
        return this.view();
      case "set-thread-leaves-no-trace":
        this.#markThread(command);
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
    );
    if (!command.leavesNoTrace) {
      this.#untraced.delete(key);
      this.#writeSettings(this.#settings, "restart");
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
    this.#forgetThread(thread);
  }

  #forgetThread(
    thread: PersonMemoryThreadRef | { readonly mode: OctantMode; readonly threadId: string },
  ): void {
    const key = threadKey(thread);
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
        this.#writeEntry({
          ...entry,
          sources: [first, ...rest],
          updatedAt: this.#dependencies.clock(),
        });
    }
  }

  #forgetEverything(): void {
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
    this.#erase(aggregates);
    this.#entries.clear();
    this.#digests.clear();
    this.#writeSettings(this.#settings, "restart");
  }

  /**
   * `restart` moves the start of memory to now. Forgetting, switching memory
   * back on, letting a Project back in, or allowing a thread again must not
   * learn from what ended while it was off, kept out, or just forgotten.
   */
  #writeSettings(settings: PersonMemorySettings, boundary: "keep" | "restart" = "keep"): void {
    const since =
      boundary === "restart"
        ? this.#dependencies.clock()
        : (this.#since ?? this.#dependencies.clock());
    const envelope = this.#append(
      PERSON_MEMORY_SETTINGS_AGGREGATE_TYPE,
      SETTINGS_AGGREGATE_ID,
      this.#settingsVersion,
      PERSON_MEMORY_SETTINGS_CHANGED,
      { settings, since },
    );
    this.#settings = settings;
    this.#since = since;
    this.#settingsVersion = envelope.version;
  }

  /** Replaces an entry's whole history with one event naming its current state. */
  #writeEntry(entry: PersonMemoryEntry): void {
    const aggregate = {
      aggregateType: PERSON_MEMORY_ENTRY_AGGREGATE_TYPE,
      aggregateId: String(entry.id),
    };
    if (this.#entries.has(String(entry.id))) this.#erase([aggregate]);
    this.#append(aggregate.aggregateType, aggregate.aggregateId, 0, PERSON_MEMORY_ENTRY_RECORDED, {
      entry,
    });
    this.#entries.set(String(entry.id), entry);
  }

  #eraseEntry(id: string): void {
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
          actor: this.#dependencies.actor,
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
    ])) {
      switch (envelope.eventName) {
        case PERSON_MEMORY_SETTINGS_CHANGED: {
          const changed = decodeSettingsChanged(envelope.payload);
          this.#settings = changed.settings;
          this.#since = changed.since;
          this.#settingsVersion = envelope.aggregateVersion;
          break;
        }
        case PERSON_MEMORY_ENTRY_RECORDED: {
          const { entry } = decodeEntryRecorded(envelope.payload);
          this.#entries.set(String(entry.id), entry);
          break;
        }
        case PERSON_MEMORY_THREAD_REMEMBERED: {
          const { digest } = decodeThreadRemembered(envelope.payload);
          this.#digests.set(threadKey(digest.source), digest);
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
