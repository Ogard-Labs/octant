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
} from "./serverAttachments";
import type { ServerAddress, ServerConnection } from "./serverConnection";
import { SERVER_THREAD_ATTACHMENTS } from "./serverFiles";
import type { ServerProjectStore } from "./serverProjectStore";

/**
 * Removes thread attachment folders copied onto registered SSH servers when a
 * thread is deleted/purged or marked Leave no trace, or when its whole server
 * Project is removed. Canonical: docs/design/server-projects.md § Threads.
 *
 * When a server cannot be reached during thread deletion, purge, or Leave no
 * trace, local state is never held up: a pending removal is journaled under
 * its own aggregate (which thread purge retains) and retried automatically on
 * the next successful SSH connection to that exact server alias and user.
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
  readonly #inFlightThreads = new Map<string, Promise<ServerAttachmentThreadCleanupOutcome>>();
  readonly #inFlightDrains = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
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
      if (this.#hasPendingFor(server)) {
        this.#trackBackground(this.drainForServer(server));
      }
    });
  }

  close(): void {
    this.#unsubscribeJournal?.();
    this.#unsubscribeJournal = undefined;
    this.#unsubscribeConnection?.();
    this.#unsubscribeConnection = undefined;
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
    if (!this.#hasPendingFor(server)) return Promise.resolve();
    const serverKey = `${server.user}\0${server.alias}`;
    const existing = this.#inFlightDrains.get(serverKey);
    if (existing !== undefined) return existing;
    const task = this.#drainServerNow(server).finally(() => {
      if (this.#inFlightDrains.get(serverKey) === task) this.#inFlightDrains.delete(serverKey);
    });
    this.#inFlightDrains.set(serverKey, task);
    return task;
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
    const projectId = String(input.project.id);
    const threadIdSet = new Set<string>();
    for (const threadId of this.#options.listThreadsForProject(projectId)) {
      if (isSafeServerAttachmentThreadId(threadId)) threadIdSet.add(threadId);
    }
    for (const entry of this.#pending.values()) {
      if (String(entry.projectId) === projectId && isSafeServerAttachmentThreadId(entry.threadId)) {
        threadIdSet.add(entry.threadId);
      }
    }
    const threadIds = [...threadIdSet].sort();
    if (input.server === undefined) {
      return formatLeftBehindNotice(input.project.name, undefined, threadIds);
    }
    if (this.#options.connection.refusal?.(input.server) !== undefined) {
      for (const threadId of threadIds) {
        this.#recordPending(input.project, input.server, threadId);
      }
      return formatLeftBehindNotice(input.project.name, input.server.alias, threadIds);
    }
    if (threadIds.length === 0) {
      const reachable = await checkServerAttachmentReachable({
        connection: this.#options.connection,
        server: input.server,
        timeoutMs: this.#inlineTimeoutMs,
      });
      return reachable
        ? undefined
        : formatLeftBehindNotice(input.project.name, input.server.alias, []);
    }
    const outcome = await removeServerThreadAttachments({
      connection: this.#options.connection,
      server: input.server,
      threadIds,
      timeoutMs: this.#inlineTimeoutMs,
    });
    if (outcome.status === "removed") {
      for (const threadId of threadIds) {
        this.#settleIfPending(String(input.project.serverId), threadId);
      }
      return undefined;
    }
    for (const threadId of threadIds) {
      this.#recordPending(input.project, input.server, threadId);
    }
    return formatLeftBehindNotice(input.project.name, input.server.alias, threadIds);
  }

  async #removeForThreadNow(
    project: ServerProject,
    threadId: string,
    aggregateId: string,
  ): Promise<ServerAttachmentThreadCleanupOutcome> {
    const address = this.#options.store.addressOf(String(project.id));
    if (address.kind !== "address") return { status: "skipped" };
    if (this.#options.connection.refusal?.(address.server) !== undefined) {
      this.#recordPending(project, address.server, threadId);
      return { status: "pending" };
    }
    const outcome = await removeServerThreadAttachments({
      connection: this.#options.connection,
      server: address.server,
      threadIds: [threadId],
      timeoutMs: this.#inlineTimeoutMs,
    });
    if (outcome.status === "removed") {
      this.#settlePendingById(aggregateId);
      return { status: "removed" };
    }
    if (outcome.status === "refused") return { status: "refused" };
    this.#recordPending(project, address.server, threadId);
    return { status: "pending" };
  }

  async #drainServerNow(server: ServerAddress): Promise<void> {
    if (this.#options.connection.refusal?.(server) !== undefined) return;
    for (;;) {
      const entries = [...this.#pending.entries()].filter(
        ([, entry]) => entry.alias === server.alias && entry.user === server.user,
      );
      if (entries.length === 0) return;
      const threadIds = entries.map(([, entry]) => entry.threadId);
      const outcome = await removeServerThreadAttachments({
        connection: this.#options.connection,
        server,
        threadIds,
        timeoutMs: this.#drainTimeoutMs,
      });
      if (outcome.status !== "removed") return;
      for (const [aggregateId] of entries) {
        this.#settlePendingById(aggregateId);
      }
    }
  }

  #onCommitted(append: CommittedAppend): void {
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

  #hasPendingFor(server: ServerAddress): boolean {
    for (const entry of this.#pending.values()) {
      if (entry.alias === server.alias && entry.user === server.user) return true;
    }
    return false;
  }

  #recordPending(project: ServerProject, server: ServerAddress, threadId: string): void {
    if (!isSafeServerAttachmentThreadId(threadId)) return;
    const aggregateId = pendingAggregateId(String(project.serverId), threadId);
    if (this.#pending.has(aggregateId)) return;
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
    }
  }

  #settleIfPending(serverId: string, threadId: string): void {
    this.#settlePendingById(pendingAggregateId(serverId, threadId));
  }

  #settlePendingById(aggregateId: string): void {
    const entry = this.#pending.get(aggregateId);
    if (entry === undefined) return;
    const payload = decodeServerAttachmentCleanupSettledPayload({
      serverId: entry.serverId,
      projectId: entry.projectId,
      threadId: entry.threadId,
      settledAt: decodeTimestamp(this.#options.clock()),
    });
    if (this.#append(aggregateId, SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.settled, payload)) {
      this.#pending.delete(aggregateId);
    }
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
    } catch {
      return false;
    }
    this.#versions.set(aggregateId, expectedVersion + 1);
    return true;
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
