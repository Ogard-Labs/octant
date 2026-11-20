import { createHash } from "node:crypto";
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type CommittedAppend,
  type EventActor as EventActorValue,
  type OctantMode,
} from "@octant/contracts";
import {
  PERSON_MEMORY_THREAD_UNTRACED,
  PersonMemoryThreadUntraced,
} from "@octant/contracts/person-memory";
import {
  decodeServerAttachmentCleanupPendingPayload,
  decodeServerAttachmentCleanupSettledPayload,
  decodeServerAttachmentThreadId,
  SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
  SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES,
  type ServerAttachmentCleanupPendingPayload,
  type ServerProject,
} from "@octant/contracts/server-projects";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import {
  checkServerAttachmentReachable,
  isSafeServerAttachmentThreadId,
  removeServerThreadAttachments,
  type ServerAttachmentTransferGuard,
} from "./serverAttachments";
import type { ServerAddress, ServerConnection } from "./serverConnection";
import { SERVER_THREAD_ATTACHMENTS } from "./serverFiles";
import type { ServerProjectStore } from "./serverProjectStore";

/**
 * Removes thread attachment folders copied onto registered SSH servers when a
 * thread is deleted/purged or marked Leave no trace, or when its whole server
 * Project is removed. Canonical: docs/design/server-projects.md § Threads.
 *
 * Cleanup intent (`server-attachment-cleanup.pending@1`) is journaled before
 * SSH starts so a crash or host exit while SSH is in flight never strands a
 * remote folder. When a server cannot be reached, local deletion, purge, or
 * Leave no trace is never held up: the pending record survives thread purge
 * and host restart, is drained before any new attachment upload for that same
 * `(server, thread)`, and retries automatically on the next regular SSH
 * connection to that exact server alias and user.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeThreadUntraced = Schema.decodeUnknownSync(PersonMemoryThreadUntraced);

const REPLAY_BATCH = 500;
/** Keeps thread deletion, purge, and Project removal responsive if a server silently drops packets. */
const DEFAULT_INLINE_TIMEOUT_MS = 3_000;
/** Background retries run right after an SSH connection succeeded, so the shared control socket is warm. */
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export type ServerAttachmentThreadCleanupOutcome =
  | { readonly status: "removed" }
  | { readonly status: "pending" }
  | { readonly status: "unpersisted" }
  | { readonly status: "skipped" }
  | { readonly status: "refused" };

export interface ServerAttachmentCleanupOptions {
  readonly journal: Pick<
    Journal,
    "append" | "replayAggregateType" | "aggregateVersions" | "subscribeCommitted"
  >;
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly connection: Pick<ServerConnection, "run"> &
    Partial<Pick<ServerConnection, "subscribeConnected" | "refusal">>;
  readonly store: Pick<ServerProjectStore, "addressOf">;
  /** Resolves the bound server Project a Code or Work thread belongs to, if any. */
  readonly serverProjectForThread: (
    mode: OctantMode,
    threadId: string,
  ) => ServerProject | undefined;
  /** Lists the Code and Work thread ids currently known to belong to a server Project. */
  readonly listThreadsForProject: (projectId: string) => ReadonlyArray<string>;
  readonly inlineTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
}

export class ServerAttachmentCleanup {
  readonly #options: ServerAttachmentCleanupOptions;
  readonly #personActor: EventActorValue;
  readonly #inlineTimeoutMs: number;
  readonly #drainTimeoutMs: number;
  /** Keyed by deterministic aggregate id of `(serverId, threadId)`. */
  readonly #pending = new Map<string, ServerAttachmentCleanupPendingPayload>();
  readonly #versions = new Map<string, number>();
  /** Aggregate ids currently owned by an active removal or pre-transfer drain. */
  readonly #claimed = new Set<string>();
  /** `(server, threadId)` keys currently inside a guarded attachment transfer. */
  readonly #activeTransfers = new Set<string>();
  /** Per-`(server, threadId)` serialization tail so cleanup and upload never overlap. */
  readonly #threadChains = new Map<string, Promise<unknown>>();
  readonly #inFlightThreads = new Map<string, Promise<ServerAttachmentThreadCleanupOutcome>>();
  readonly #inFlightDrains = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  #closed = false;
  #closeController = new AbortController();
  #unsubscribeJournal: (() => void) | undefined;
  #unsubscribeConnection: (() => void) | undefined;

  constructor(options: ServerAttachmentCleanupOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
    this.#inlineTimeoutMs = options.inlineTimeoutMs ?? DEFAULT_INLINE_TIMEOUT_MS;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  /**
   * Rebuilds pending removals from the journal without connecting to any
   * server, then subscribes to Leave-no-trace commits and successful SSH
   * connections.
   */
  load(): void {
    this.#closed = false;
    this.#closeController = new AbortController();
    this.#pending.clear();
    this.#versions.clear();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        try {
          this.#apply(String(envelope.aggregateId), envelope.eventName, envelope.payload);
          this.#versions.set(String(envelope.aggregateId), envelope.aggregateVersion);
        } catch {
          // An unreadable record leaves the pending set intact.
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
      SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
    )) {
      this.#versions.set(String(aggregateId), aggregateVersion);
    }
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = this.#options.journal.subscribeCommitted((append) =>
      this.#onCommitted(append),
    );
    this.#unsubscribeConnection?.();
    this.#unsubscribeConnection = this.#options.connection.subscribeConnected?.((server) => {
      if (!this.#closed && this.#hasDrainablePendingFor(server)) {
        this.#trackBackground(this.drainForServer(server));
      }
    });
  }

  /** Stops admitting new cleanups/drains and aborts any in-flight SSH removals cleanly. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = undefined;
    this.#unsubscribeConnection?.();
    this.#unsubscribeConnection = undefined;
    this.#closeController.abort();
  }

  pending(): ReadonlyArray<ServerAttachmentCleanupPendingPayload> {
    return [...this.#pending.values()];
  }

  /** Waits until any background Leave-no-trace removals or reconnect drains settle. */
  async whenIdle(): Promise<void> {
    while (
      this.#background.size > 0 ||
      this.#inFlightThreads.size > 0 ||
      this.#inFlightDrains.size > 0
    ) {
      await Promise.allSettled([
        ...this.#background,
        ...this.#inFlightThreads.values(),
        ...this.#inFlightDrains.values(),
      ]);
    }
  }

  /**
   * Drains and settles any owed cleanup for `(server, threadId)` before new
   * files are uploaded, serialized per `(server, threadId)` so an upload can
   * never race a reconnect drain or Leave-no-trace cleanup.
   */
  readonly guardTransfer: ServerAttachmentTransferGuard = async (input) => {
    if (this.#closed || !isSafeServerAttachmentThreadId(input.threadId)) {
      return input.refused();
    }
    const key = threadTransferKey(input.server, input.threadId);
    return this.#serializeThread(key, async () => {
      if (this.#isStopped(input.signal)) return input.refused();
      this.#activeTransfers.add(key);
      try {
        const sKey = serverKey(input.server);
        if (this.#pendingForThread(input.server, input.threadId).length > 0) {
          const activeDrain = this.#inFlightDrains.get(sKey);
          if (activeDrain !== undefined) await activeDrain;
        }
        const owed = this.#pendingForThread(input.server, input.threadId);
        if (owed.length > 0) {
          if (this.#isStopped(input.signal)) return input.refused();
          const ids = owed.map(([aggregateId]) => aggregateId);
          for (const id of ids) this.#claimed.add(id);
          try {
            const outcome = await removeServerThreadAttachments({
              connection: this.#options.connection,
              server: input.server,
              threadIds: [input.threadId],
              timeoutMs: this.#drainTimeoutMs,
              signal: this.#signalFor(input.signal),
            });
            if (outcome.status !== "removed" || this.#closed) return input.refused();
            for (const id of ids) {
              if (!this.#settlePendingById(id)) return input.refused();
            }
          } finally {
            for (const id of ids) this.#claimed.delete(id);
          }
        }
        if (this.#isStopped(input.signal)) return input.refused();
        return await input.transfer();
      } finally {
        this.#activeTransfers.delete(key);
      }
    });
  };

  /**
   * Removes `~/.octant/thread-attachments/<threadId>/` when the thread belongs
   * to a server Project. Never throws so local thread purge/deletion cannot be
   * blocked by SSH failures.
   */
  async removeForThreadScope(input: {
    readonly mode: OctantMode;
    readonly threadId: string;
  }): Promise<ServerAttachmentThreadCleanupOutcome> {
    if (input.mode === "chat") return { status: "skipped" };
    const project = this.#options.serverProjectForThread(input.mode, input.threadId);
    if (project === undefined) return { status: "skipped" };
    return this.removeForThread({ project, threadId: input.threadId });
  }

  async removeForThread(input: {
    readonly project: ServerProject;
    readonly threadId: string;
  }): Promise<ServerAttachmentThreadCleanupOutcome> {
    if (!isSafeServerAttachmentThreadId(input.threadId)) return { status: "refused" };
    const key = pendingAggregateId(String(input.project.serverId), input.threadId);
    const existing = this.#inFlightThreads.get(key);
    if (existing !== undefined) return existing;
    const task = this.#removeForThreadNow(input.project, input.threadId, key).finally(() => {
      if (this.#inFlightThreads.get(key) === task) this.#inFlightThreads.delete(key);
    });
    this.#inFlightThreads.set(key, task);
    return task;
  }

  /**
   * Retries every pending removal recorded for `server` (exact alias and user).
   * Safe to invoke concurrently; overlapping drains for one server coalesce.
   */
  drainForServer(server: ServerAddress): Promise<void> {
    if (this.#closed || !this.#hasDrainablePendingFor(server)) return Promise.resolve();
    const sKey = serverKey(server);
    const existing = this.#inFlightDrains.get(sKey);
    if (existing !== undefined) return existing;
    const task = this.#drainServerNow(server).finally(() => {
      if (this.#inFlightDrains.get(sKey) === task) this.#inFlightDrains.delete(sKey);
    });
    this.#inFlightDrains.set(sKey, task);
    return task;
  }

  /**
   * Appends `server-attachment-cleanup.pending@1` for every thread of
   * `project` inside the caller's active `Journal.transaction`, without
   * mutating in-memory pending state until the returned callback runs after
   * commit. Throws if any append fails so the enclosing transaction rolls back
   * atomically alongside `server-projects.removed@1`.
   */
  stageProjectRemoval(input: {
    readonly project: ServerProject;
    readonly server: ServerAddress | undefined;
  }): () => void {
    const threadIds = this.#projectThreadIds(String(input.project.id));
    if (input.server === undefined) return () => undefined;
    const staged: Array<{
      readonly aggregateId: string;
      readonly payload: ServerAttachmentCleanupPendingPayload;
      readonly nextVersion: number;
    }> = [];
    for (const threadId of threadIds) {
      if (!isSafeServerAttachmentThreadId(threadId)) continue;
      const aggregateId = pendingAggregateId(String(input.project.serverId), threadId);
      if (this.#pending.has(aggregateId)) continue;
      const payload = decodeServerAttachmentCleanupPendingPayload({
        serverId: input.project.serverId,
        alias: input.server.alias,
        user: input.server.user,
        projectId: input.project.id,
        threadId: decodeServerAttachmentThreadId(threadId),
        queuedAt: decodeTimestamp(this.#options.clock()),
      });
      const expectedVersion = this.#versions.get(aggregateId) ?? 0;
      this.#appendRaw(
        aggregateId,
        expectedVersion,
        SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending,
        payload,
      );
      staged.push({ aggregateId, payload, nextVersion: expectedVersion + 1 });
    }
    return () => {
      for (const entry of staged) {
        this.#versions.set(entry.aggregateId, entry.nextVersion);
        this.#pending.set(entry.aggregateId, entry.payload);
      }
    };
  }

  /**
   * Removes remote attachment folders for a server Project being removed.
   * Returns a human-readable notice naming the remote folder(s) left behind
   * when the server cannot be reached, or `undefined` once everything is clean.
   */
  async removeForProject(input: {
    readonly project: ServerProject;
    readonly server: ServerAddress | undefined;
  }): Promise<string | undefined> {
    const threadIds = this.#projectThreadIds(String(input.project.id));
    if (input.server === undefined) {
      return formatLeftBehindNotice(input.project.name, undefined, threadIds);
    }
    // Idempotent when `stageProjectRemoval` already committed atomically with
    // `server-projects.removed@1`; ensures standalone callers still record
    // intent before SSH.
    for (const threadId of threadIds) {
      this.#recordPending(input.project, input.server, threadId);
    }
    if (this.#closed || this.#options.connection.refusal?.(input.server) !== undefined) {
      return formatLeftBehindNotice(input.project.name, input.server.alias, threadIds);
    }
    if (threadIds.length === 0) {
      const reachable = await checkServerAttachmentReachable({
        connection: this.#options.connection,
        server: input.server,
        timeoutMs: this.#inlineTimeoutMs,
        signal: this.#closeController.signal,
      });
      return reachable
        ? undefined
        : formatLeftBehindNotice(input.project.name, input.server.alias, []);
    }
    const serverId = String(input.project.serverId);
    const aggregateIds = threadIds.map((threadId) => pendingAggregateId(serverId, threadId));
    for (const id of aggregateIds) this.#claimed.add(id);
    try {
      const outcome = await removeServerThreadAttachments({
        connection: this.#options.connection,
        server: input.server,
        threadIds,
        timeoutMs: this.#inlineTimeoutMs,
        signal: this.#closeController.signal,
      });
      if (outcome.status === "removed" && !this.#closed) {
        for (const id of aggregateIds) {
          this.#settlePendingById(id);
        }
        return undefined;
      }
      return formatLeftBehindNotice(input.project.name, input.server.alias, threadIds);
    } finally {
      for (const id of aggregateIds) this.#claimed.delete(id);
    }
  }

  async #removeForThreadNow(
    project: ServerProject,
    threadId: string,
    aggregateId: string,
  ): Promise<ServerAttachmentThreadCleanupOutcome> {
    const address = this.#options.store.addressOf(String(project.id));
    if (address.kind !== "address") return { status: "skipped" };
    // Journal intent before starting SSH so a crash mid-call survives restart.
    const intentPersisted = this.#recordPending(project, address.server, threadId);
    if (this.#closed || this.#options.connection.refusal?.(address.server) !== undefined) {
      return intentPersisted ? { status: "pending" } : { status: "unpersisted" };
    }
    const key = threadTransferKey(address.server, threadId);
    return this.#serializeThread(key, async () => {
      if (this.#closed) {
        return intentPersisted ? { status: "pending" } : { status: "unpersisted" };
      }
      // Only treat an absent `#pending` entry as already removed when we
      // actually had a durable pending entry that another operation settled
      // while we waited in the per-thread queue.
      if (intentPersisted && !this.#pending.has(aggregateId)) {
        return { status: "removed" };
      }
      this.#claimed.add(aggregateId);
      try {
        const outcome = await removeServerThreadAttachments({
          connection: this.#options.connection,
          server: address.server,
          threadIds: [threadId],
          timeoutMs: this.#inlineTimeoutMs,
          signal: this.#closeController.signal,
        });
        if (outcome.status === "removed") {
          if (!intentPersisted) return { status: "removed" };
          if (this.#closed) return { status: "pending" };
          return this.#settlePendingById(aggregateId)
            ? { status: "removed" }
            : { status: "pending" };
        }
        if (outcome.status === "refused") return { status: "refused" };
        if (!intentPersisted && !this.#closed) {
          return this.#recordPending(project, address.server, threadId)
            ? { status: "pending" }
            : { status: "unpersisted" };
        }
        return intentPersisted ? { status: "pending" } : { status: "unpersisted" };
      } finally {
        this.#claimed.delete(aggregateId);
      }
    });
  }

  async #drainServerNow(server: ServerAddress): Promise<void> {
    if (this.#closed || this.#options.connection.refusal?.(server) !== undefined) return;
    for (;;) {
      if (this.#closed || this.#options.connection.refusal?.(server) !== undefined) return;
      const entries = this.#drainableEntriesFor(server);
      if (entries.length === 0) return;
      const ids = entries.map(([aggregateId]) => aggregateId);
      const threadIds = entries.map(([, entry]) => entry.threadId);
      for (const id of ids) this.#claimed.add(id);
      let settledCount = 0;
      let allSettled = true;
      try {
        const outcome = await removeServerThreadAttachments({
          connection: this.#options.connection,
          server,
          threadIds,
          timeoutMs: this.#drainTimeoutMs,
          signal: this.#closeController.signal,
        });
        if (outcome.status !== "removed" || this.#closed) return;
        for (const id of ids) {
          if (this.#settlePendingById(id)) settledCount += 1;
          else allSettled = false;
        }
      } finally {
        for (const id of ids) this.#claimed.delete(id);
      }
      // Stop immediately when journal persistence fails or makes no progress so
      // a closing or failing store never triggers an endless SSH retry loop.
      if (!allSettled || settledCount === 0) return;
    }
  }

  #onCommitted(append: CommittedAppend): void {
    if (this.#closed) return;
    for (const event of append.events) {
      if (event.eventName !== PERSON_MEMORY_THREAD_UNTRACED) continue;
      let mark: ReturnType<typeof decodeThreadUntraced>;
      try {
        mark = decodeThreadUntraced(event.payload);
      } catch {
        continue;
      }
      if (!mark.leavesNoTrace || mark.mode === "chat") continue;
      const project = this.#options.serverProjectForThread(mark.mode, String(mark.threadId));
      if (project === undefined) continue;
      this.#trackBackground(this.removeForThread({ project, threadId: String(mark.threadId) }));
    }
  }

  #projectThreadIds(projectId: string): ReadonlyArray<string> {
    const threadIdSet = new Set<string>();
    for (const threadId of this.#options.listThreadsForProject(projectId)) {
      if (isSafeServerAttachmentThreadId(threadId)) threadIdSet.add(threadId);
    }
    for (const entry of this.#pending.values()) {
      if (String(entry.projectId) === projectId && isSafeServerAttachmentThreadId(entry.threadId)) {
        threadIdSet.add(entry.threadId);
      }
    }
    return [...threadIdSet].sort();
  }

  #pendingForThread(
    server: ServerAddress,
    threadId: string,
  ): ReadonlyArray<readonly [string, ServerAttachmentCleanupPendingPayload]> {
    return [...this.#pending.entries()].filter(
      ([, entry]) =>
        entry.alias === server.alias && entry.user === server.user && entry.threadId === threadId,
    );
  }

  #drainableEntriesFor(
    server: ServerAddress,
  ): ReadonlyArray<readonly [string, ServerAttachmentCleanupPendingPayload]> {
    return [...this.#pending.entries()].filter(
      ([aggregateId, entry]) =>
        entry.alias === server.alias &&
        entry.user === server.user &&
        !this.#claimed.has(aggregateId) &&
        !this.#activeTransfers.has(threadTransferKey(server, entry.threadId)),
    );
  }

  #hasDrainablePendingFor(server: ServerAddress): boolean {
    return this.#drainableEntriesFor(server).length > 0;
  }

  #recordPending(project: ServerProject, server: ServerAddress, threadId: string): boolean {
    if (!isSafeServerAttachmentThreadId(threadId)) return false;
    const aggregateId = pendingAggregateId(String(project.serverId), threadId);
    if (this.#pending.has(aggregateId)) return true;
    const payload = decodeServerAttachmentCleanupPendingPayload({
      serverId: project.serverId,
      alias: server.alias,
      user: server.user,
      projectId: project.id,
      threadId: decodeServerAttachmentThreadId(threadId),
      queuedAt: decodeTimestamp(this.#options.clock()),
    });
    if (this.#append(aggregateId, SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending, payload)) {
      this.#pending.set(aggregateId, payload);
      return true;
    }
    return false;
  }

  #settlePendingById(aggregateId: string): boolean {
    const entry = this.#pending.get(aggregateId);
    if (entry === undefined) return true;
    const payload = decodeServerAttachmentCleanupSettledPayload({
      serverId: entry.serverId,
      projectId: entry.projectId,
      threadId: entry.threadId,
      settledAt: decodeTimestamp(this.#options.clock()),
    });
    if (this.#append(aggregateId, SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.settled, payload)) {
      this.#pending.delete(aggregateId);
      return true;
    }
    return false;
  }

  #apply(aggregateId: string, eventName: string, payload: unknown): void {
    if (eventName === SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending) {
      this.#pending.set(aggregateId, decodeServerAttachmentCleanupPendingPayload(payload));
      return;
    }
    if (eventName === SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.settled) {
      decodeServerAttachmentCleanupSettledPayload(payload);
      this.#pending.delete(aggregateId);
    }
  }

  #append(aggregateId: string, eventName: string, payload: unknown): boolean {
    const expectedVersion = this.#versions.get(aggregateId) ?? 0;
    try {
      this.#appendRaw(aggregateId, expectedVersion, eventName, payload);
    } catch {
      return false;
    }
    this.#versions.set(aggregateId, expectedVersion + 1);
    return true;
  }

  #appendRaw(
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
        aggregateId: decodeAggregateId(aggregateId),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor: this.#personActor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }

  #serializeThread<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#threadChains.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const cleaned = tail.finally(() => {
      if (this.#threadChains.get(key) === cleaned) this.#threadChains.delete(key);
    });
    this.#threadChains.set(key, cleaned);
    return run;
  }

  #isStopped(signal: AbortSignal | undefined): boolean {
    return this.#closed || signal?.aborted === true;
  }

  #signalFor(extra: AbortSignal | undefined): AbortSignal {
    return extra === undefined
      ? this.#closeController.signal
      : AbortSignal.any([this.#closeController.signal, extra]);
  }

  #trackBackground(promise: Promise<unknown>): void {
    const tracked = promise
      .catch(() => undefined)
      .finally(() => {
        this.#background.delete(tracked);
      });
    this.#background.add(tracked);
  }
}

function serverKey(server: ServerAddress): string {
  return `${server.user}\0${server.alias}`;
}

function threadTransferKey(server: ServerAddress, threadId: string): string {
  return `${server.user}\0${server.alias}\0${threadId}`;
}

/** Deterministic UUID aggregate id for one pending `(serverId, threadId)` removal. */
function pendingAggregateId(serverId: string, threadId: string): string {
  const hex = createHash("sha256")
    .update("octant.server-attachment-cleanup.v1\0")
    .update(serverId)
    .update("\0")
    .update(threadId)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function formatLeftBehindNotice(
  projectName: string,
  alias: string | undefined,
  threadIds: ReadonlyArray<string>,
): string {
  const base = `~/${SERVER_THREAD_ATTACHMENTS}/`;
  const folderLabel =
    threadIds.length === 1
      ? `${base}${threadIds[0]}/`
      : threadIds.length > 1 && threadIds.length <= 3
        ? `${base} (${threadIds.map((id) => `${base}${id}/`).join(", ")})`
        : threadIds.length > 3
          ? `${base} (${String(threadIds.length)} thread folders)`
          : base;
  const targetNoun = threadIds.length === 1 ? "that folder" : "those folders";
  if (alias === undefined) {
    return threadIds.length > 0
      ? `Removed ${projectName}, but its server is no longer registered, so Octant could not delete attached files left in ${folderLabel}. You can remove ${targetNoun} on the server directly.`
      : `Removed ${projectName}, but its server is no longer registered, so Octant could not check for attached files left in ${base}. You can remove any leftover folders there on the server directly.`;
  }
  return threadIds.length > 0
    ? `Removed ${projectName}, but ${alias} could not be reached to delete attached files left in ${folderLabel}. You can remove ${targetNoun} on the server when it is reachable.`
    : `Removed ${projectName}, but ${alias} could not be reached to check for attached files left in ${base}. You can remove any leftover folders there on the server when it is reachable.`;
}
