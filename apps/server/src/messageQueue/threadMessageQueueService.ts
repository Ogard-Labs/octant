import {
  UtcTimestamp,
  decodeAggregateVersion,
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueuePayload,
  MAX_THREAD_MESSAGE_QUEUE_ITEMS,
  MAX_THREAD_MESSAGE_QUEUE_BYTES,
  MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES,
  decodeChatDeleted,
  decodeThreadMessageQueueScope,
  decodeThreadRetentionThreadPurged,
  THREAD_RETENTION_EVENT_NAMES,
  type CommittedAppend,
  type EventActor,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueHoldReason,
  type ThreadMessageQueueReadResult,
  type ThreadMessageQueueRefusalReason,
  type ThreadMessageQueueResult,
  type ThreadMessageQueueScope,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES,
  type ThreadMessageQueueModePort,
  type ThreadMessageQueueResource,
  type ThreadMessageQueueInspection,
} from "./threadMessageQueuePort";
import {
  queueId,
  queueFingerprint,
  ThreadMessageQueuePersistence,
  type QueueContent,
  type QueueState,
} from "./threadMessageQueuePersistence";

export interface ThreadMessageQueueServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly port: ThreadMessageQueueModePort;
  readonly actor: EventActor;
  readonly clock?: () => string;
}
interface LiveAuthorization {
  readonly windowId: WindowId;
  readonly scope: ThreadMessageQueueScope;
  readonly acknowledgedTail?: string;
}
export class ThreadMessageQueueService {
  readonly #store: ThreadMessageQueuePersistence;
  readonly #port: ThreadMessageQueueModePort;
  readonly #clock: () => string;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #pendingTicks = new Set<string>();
  readonly #authorized = new Map<string, LiveAuthorization>();
  readonly #retained = new Map<string, ThreadMessageQueueResource>();
  readonly #controllers = new Map<
    string,
    { readonly windowId: WindowId; readonly controller: AbortController }
  >();
  readonly #revoked = new Set<string>();
  readonly #purging = new Set<string>();
  #disposed = false;
  constructor(options: ThreadMessageQueueServiceOptions) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#store = new ThreadMessageQueuePersistence({ ...options, clock: this.#clock });
    this.#port = options.port;
  }
  async read(
    windowId: WindowId,
    scope: ThreadMessageQueueScope,
  ): Promise<ThreadMessageQueueReadResult> {
    const inspected = await this.#inspect({ scope, windowId, intent: "read" });
    if (inspected.status === "held") return { status: "refused", reason: inspected.reason };
    if (this.#store.purged(scope)) return { status: "refused", reason: "thread-unavailable" };
    return { status: "ready", snapshot: this.#store.snapshot(scope) };
  }
  async execute(
    windowId: WindowId,
    raw: ThreadMessageQueueCommand,
  ): Promise<ThreadMessageQueueResult> {
    let command: ThreadMessageQueueCommand;
    try {
      command = decodeThreadMessageQueueCommand(raw);
    } catch {
      return { status: "refused", requestId: raw.requestId, reason: "invalid-payload" };
    }
    return this.#serial(command.scope, async () => {
      const refused = (reason: ThreadMessageQueueRefusalReason): ThreadMessageQueueResult => ({
        status: "refused",
        requestId: command.requestId,
        reason,
      });
      const result = (status: "applied" | "duplicate" | "conflict"): ThreadMessageQueueResult => ({
        status,
        requestId: command.requestId,
        snapshot: this.#store.snapshot(command.scope),
      });
      if (this.#disposed) return refused("authority-revoked");
      const inspection = await this.#inspect({
        scope: command.scope,
        windowId,
        intent: command.kind,
        ...(command.kind === "enqueue" ? { payload: command.payload } : {}),
      });
      if (inspection.status === "held") return refused(inspection.reason);
      if (this.#purging.has(queueId(command.scope)) || this.#store.purged(command.scope))
        return refused("thread-unavailable");
      const id = queueId(command.scope);
      const receipt = this.#store.receipt(command.requestId);
      if (receipt !== undefined)
        return receipt.queue_id === id && receipt.fingerprint === queueFingerprint(command)
          ? result("duplicate")
          : refused("invalid-payload");
      if (command.kind === "enqueue") {
        const previous = this.#store.identity(command.messageId);
        if (previous !== undefined)
          return previous.queue_id === id &&
            previous.fingerprint ===
              queueFingerprint({ scope: command.scope, payload: command.payload })
            ? result("duplicate")
            : refused("invalid-payload");
      }
      const state = this.#store.state(command.scope);
      if (state.version !== command.expectedVersion) return result("conflict");
      if (command.kind === "enqueue") {
        if (
          state.items.length >= MAX_THREAD_MESSAGE_QUEUE_ITEMS ||
          this.#store.contents(command.scope).length >= MAX_THREAD_MESSAGE_QUEUE_ITEMS
        )
          return refused("queue-full");
        let content: QueueContent = {
          scope: command.scope,
          messageId: command.messageId,
          payload: command.payload,
          binding: inspection.binding,
          ...(inspection.privateContextJson === undefined
            ? {}
            : { privateContextJson: inspection.privateContextJson }),
        };
        if (!validContent(content)) return refused("invalid-payload");
        const retained = this.#port.retain({ ...content, reason: "enqueue" });
        if (retained.status === "refused") return refused(retained.reason);
        if (retained.privateContextJson !== undefined)
          content = { ...content, privateContextJson: retained.privateContextJson };
        this.#retained.set(command.messageId, content);
        // No asynchronous boundary may separate the pin and the atomic append.
        const size =
          this.#store
            .contents(command.scope)
            .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) +
          Buffer.byteLength(JSON.stringify(content));
        if (!validContent(content) || size > MAX_THREAD_MESSAGE_QUEUE_BYTES) {
          await this.#release(content, "rollback");
          return refused("queue-full");
        }
        const outcome = this.#store.write(
          {
            ...state,
            items: [
              ...state.items,
              {
                messageId: command.messageId,
                status: "queued",
                revision: decodeAggregateVersion(1),
                createdAt: decodeTime(this.#clock()),
              },
            ],
          },
          { command, content },
        );
        if (outcome !== "applied") {
          await this.#release(content, "rollback");
          return outcome === "conflict" ? result("conflict") : refused("storage-unavailable");
        }
        this.#port.commit(content);
        this.#authorized.set(command.messageId, authorization(windowId, inspection, command.scope));
        return result("applied");
      }
      if (command.kind === "edit" || command.kind === "remove") {
        const item = state.items.find(
          (item) => String(item.messageId) === String(command.messageId),
        );
        if (item === undefined) return refused("not-found");
        if (item.status !== "queued") return refused("not-editable");
        const content = this.#store.content(item.messageId);
        if (command.kind === "edit") {
          if (content === undefined) return refused("content-unavailable");
          let updated: QueueContent;
          try {
            updated = {
              ...content,
              payload: decodeThreadMessageQueuePayload({
                ...content.payload,
                prompt: command.prompt,
              }),
            };
          } catch {
            return refused("invalid-payload");
          }
          const size = this.#store
            .contents(command.scope)
            .reduce(
              (sum, item) =>
                sum +
                Buffer.byteLength(
                  JSON.stringify(
                    String(item.messageId) === String(updated.messageId) ? updated : item,
                  ),
                ),
              0,
            );
          if (!validContent(updated) || size > MAX_THREAD_MESSAGE_QUEUE_BYTES)
            return refused("queue-full");
          const outcome = this.#store.write(
            {
              ...state,
              items: state.items.map((value) =>
                value === item
                  ? { ...value, revision: decodeAggregateVersion(value.revision + 1) }
                  : value,
              ),
            },
            { command, content: updated },
          );
          if (outcome === "applied" && this.#retained.has(item.messageId))
            this.#retained.set(item.messageId, updated);
          return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
        }
        const outcome = this.#store.write(
          { ...state, items: state.items.filter((value) => value !== item) },
          { command, settled: { messageId: item.messageId, status: "removed" } },
        );
        if (outcome === "applied") {
          this.#authorized.delete(item.messageId);
          if (content !== undefined) await this.#release(content, "removed", true);
        }
        return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
      }
      if (command.kind === "reorder") {
        if (
          command.messageIds.length !== state.items.length ||
          new Set(command.messageIds).size !== state.items.length
        )
          return refused("invalid-order");
        const items = command.messageIds.map((id) =>
          state.items.find((item) => String(item.messageId) === String(id)),
        );
        if (items.some((item) => item === undefined)) return refused("invalid-order");
        const defined = items.filter((item) => item !== undefined);
        if (state.items.some((item, index) => item.status !== "queued" && defined[index] !== item))
          return refused("not-editable");
        const outcome = this.#store.write({ ...state, items: defined }, { command });
        return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
      }
      if (command.kind === "resume") {
        if (state.items.some((item) => item.status === "dispatching"))
          return refused("delivery-unknown");
        const authorizations = new Map<string, LiveAuthorization>();
        for (const item of state.items) {
          const content = this.#store.content(item.messageId);
          if (content === undefined) return refused("content-unavailable");
          const current = await this.#inspect({
            scope: command.scope,
            windowId,
            intent: "resume",
            payload: content.payload,
          });
          if (current.status === "held") return refused(current.reason);
          if (current.binding !== content.binding) return refused("binding-changed");
          if (item.status === "queued" && !this.#retained.has(item.messageId)) {
            const retained = this.#port.retain({ ...content, reason: "restore" });
            if (retained.status === "refused") return refused(retained.reason);
            this.#retained.set(item.messageId, content);
          }
          authorizations.set(item.messageId, authorization(windowId, current, command.scope));
        }
        const { holdReason: _hold, ...withoutHold } = state;
        const outcome = this.#store.write({ ...withoutHold, paused: false }, { command });
        if (outcome === "applied")
          for (const [key, value] of authorizations) this.#authorized.set(key, value);
        return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
      }
      const outcome = this.#store.write(
        { ...state, paused: true, holdReason: "paused" },
        { command },
      );
      return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
    });
  }
  /** Run after projection catch-up, before attachment recovery and route admission. */
  async recover(): Promise<void> {
    this.#authorized.clear();
    const failures = new Set<string>();
    for (const content of this.#store.contents()) {
      if (this.#store.purged(content.scope)) {
        this.#store.deleteContent(content.messageId);
        continue;
      }
      const retained = this.#port.retain({ ...content, reason: "restore" });
      if (retained.status === "retained") this.#retained.set(content.messageId, content);
      else failures.add(queueId(content.scope));
    }
    for (const scope of this.#store.scopes())
      await this.#serial(scope, async () => {
        const state = this.#store.state(scope);
        if (state.items.length > 0)
          this.#hold(state, failures.has(queueId(scope)) ? "content-unavailable" : "host-restart");
        await this.#cleanup(scope);
      });
  }
  async tick(scope?: ThreadMessageQueueScope): Promise<void> {
    if (this.#disposed) return;
    const scopes =
      scope === undefined
        ? [
            ...new Map(
              [
                ...this.#store.scopes(),
                ...[...this.#retained.values()].map((resource) => resource.scope),
              ].map((scope) => [queueId(scope), scope]),
            ).values(),
          ]
        : [scope];
    await Promise.all(
      scopes.map(async (current) => {
        const key = queueId(current);
        if (this.#pendingTicks.has(key)) return;
        this.#pendingTicks.add(key);
        try {
          await this.#serial(current, () => this.#tick(current));
        } finally {
          this.#pendingTicks.delete(key);
        }
      }),
    );
  }
  async #tick(scope: ThreadMessageQueueScope): Promise<void> {
    if (this.#disposed || this.#purging.has(queueId(scope))) return;
    if (this.#store.purged(scope)) {
      for (const content of this.#retained.values())
        if (queueId(content.scope) === queueId(scope)) await this.#release(content, "purged", true);
      return;
    }
    await this.#cleanup(scope);
    if (this.#disposed) return;
    let state = this.#store.state(scope);
    let head = state.items[0];
    if (head === undefined) return;
    if (head.status !== "queued") {
      let reconciled: Awaited<ReturnType<ThreadMessageQueueModePort["reconcile"]>>;
      try {
        reconciled = await this.#port.reconcile({ scope, messageId: head.messageId });
      } catch {
        reconciled = { status: "unknown" };
      }
      if (this.#disposed) return;
      if (reconciled.status === "unknown") {
        this.#hold(state, "delivery-unknown");
        return;
      }
      if (reconciled.status === "accepted") {
        if (head.status !== "accepted")
          this.#store.write({
            ...state,
            items: state.items.map((item) =>
              item === head ? { ...item, status: "accepted" } : item,
            ),
          });
        const content = this.#store.content(head.messageId);
        if (content) await this.#release(content, "accepted");
        return;
      }
      if (reconciled.status === "not-admitted") {
        // Durable absence permits an explicit resume, never an automatic replay.
        if (head.status === "dispatching")
          this.#store.write({
            ...state,
            holdReason: "delivery-unknown",
            items: state.items.map((item) =>
              item === head ? { ...item, status: "queued" } : item,
            ),
          });
        else this.#hold(state, "delivery-unknown");
        return;
      }
      const terminal = reconciled.status;
      const outcome = this.#store.write(
        {
          ...state,
          items: state.items.slice(1),
          ...(terminal === "completed" ? {} : { holdReason: terminal }),
        },
        { settled: { messageId: head.messageId, status: terminal } },
      );
      if (outcome !== "applied") return;
      this.#authorized.delete(head.messageId);
      const content = this.#store.content(head.messageId);
      if (content) await this.#release(content, "accepted", true);
      state = this.#store.state(scope);
      head = state.items[0];
    }
    if (head === undefined || state.paused || state.holdReason !== undefined || this.#disposed)
      return;
    const content = this.#store.content(head.messageId);
    if (content === undefined) {
      this.#hold(state, "content-unavailable");
      return;
    }
    const auth = this.#authorized.get(head.messageId);
    if (auth === undefined) {
      this.#hold(state, "host-restart");
      return;
    }
    const inspection = await this.#inspect({
      scope,
      windowId: auth.windowId,
      intent: "dispatch",
      payload: content.payload,
    });
    if (!this.#authorized.has(head.messageId) || this.#disposed) {
      this.#hold(state, "authority-revoked");
      return;
    }
    if (inspection.status === "held") {
      this.#hold(state, holdReason(inspection.reason));
      return;
    }
    if (inspection.binding !== content.binding) {
      this.#hold(state, "binding-changed");
      return;
    }
    if (
      inspection.tail &&
      (inspection.tail.status === "cancelled" || inspection.tail.status === "failed") &&
      inspection.tail.id !== auth.acknowledgedTail
    ) {
      this.#hold(state, inspection.tail.status);
      return;
    }
    if (inspection.status === "busy") return;
    if (
      this.#store.write({
        ...state,
        items: state.items.map((item) =>
          item === head ? { ...item, status: "dispatching" } : item,
        ),
      }) !== "applied"
    )
      return;
    const controller = new AbortController();
    this.#controllers.set(head.messageId, { windowId: auth.windowId, controller });
    let admission: Awaited<ReturnType<ThreadMessageQueueModePort["admit"]>>;
    try {
      admission = await this.#port.admit({
        ...content,
        windowId: auth.windowId,
        signal: controller.signal,
      });
    } catch {
      admission = { status: "unknown" };
    }
    this.#controllers.delete(head.messageId);
    if (this.#disposed) return;
    state = this.#store.state(scope);
    if (admission.status === "accepted") {
      this.#store.write({
        ...state,
        items: state.items.map((item) =>
          String(item.messageId) === String(content.messageId)
            ? { ...item, status: "accepted" }
            : item,
        ),
        ...(controller.signal.aborted ? { holdReason: "authority-revoked" } : {}),
      });
      await this.#release(content, "accepted");
    } else if (admission.status === "refused") {
      this.#store.write({
        ...state,
        holdReason: admission.reason,
        items: state.items.map((item) =>
          String(item.messageId) === String(content.messageId)
            ? { ...item, status: "queued" }
            : item,
        ),
      });
    } else this.#hold(state, "delivery-unknown");
  }
  async revokeWindow(windowId: WindowId): Promise<void> {
    this.#revoked.add(String(windowId));
    const scopes = new Map<string, ThreadMessageQueueScope>();
    for (const [messageId, auth] of this.#authorized)
      if (String(auth.windowId) === String(windowId)) {
        this.#authorized.delete(messageId);
        const content = this.#store.content(messageId);
        if (content) scopes.set(queueId(content.scope), content.scope);
      }
    for (const entry of this.#controllers.values())
      if (String(entry.windowId) === String(windowId)) entry.controller.abort();
    await Promise.all(
      [...scopes.values()].map((scope) =>
        this.#serial(scope, async () => {
          this.#hold(this.#store.state(scope), "authority-revoked");
        }),
      ),
    );
  }
  async purgeThread(
    scope: ThreadMessageQueueScope,
  ): Promise<{ readonly status: "released" | "refused" }> {
    // Artifact cleanup can await I/O before the parent writes its purge event.
    this.#purging.add(queueId(scope));
    for (const item of this.#store.state(scope).items) {
      this.#authorized.delete(item.messageId);
      this.#controllers.get(item.messageId)?.controller.abort();
    }
    return this.#serial(scope, async () => {
      const state = this.#store.state(scope);
      if (state.items.length > 0) this.#hold(state, "thread-unavailable");
      let refused = false;
      for (const content of this.#store.contents(scope))
        if (!(await this.#release(content, "purged", true))) refused = true;
      return { status: refused ? "refused" : "released" };
    });
  }
  async onCommittedAppend(append: CommittedAppend): Promise<void> {
    for (const event of append.events) {
      if (event.eventVersion !== 1) continue;
      if (
        event.eventName !== "chat.deleted@1" &&
        event.eventName !== THREAD_RETENTION_EVENT_NAMES.threadPurged
      )
        continue;
      const deleted =
        event.eventName === "chat.deleted@1"
          ? { mode: "chat", threadId: decodeChatDeleted(event.payload).threadId }
          : decodeThreadRetentionThreadPurged(event.payload);
      const scope = decodeThreadMessageQueueScope({
        mode: deleted.mode,
        threadId: deleted.threadId,
      });
      for (const [messageId, auth] of this.#authorized)
        if (queueId(auth.scope) === queueId(scope)) {
          this.#authorized.delete(messageId);
          this.#controllers.get(messageId)?.controller.abort();
        }
      const retained = [...this.#retained.values()].filter(
        (content) => queueId(content.scope) === queueId(scope),
      );
      for (const content of retained) {
        this.#authorized.delete(content.messageId);
        this.#controllers.get(content.messageId)?.controller.abort();
      }
      await this.#serial(scope, async () => {
        for (const content of retained) await this.#release(content, "purged", true);
      });
    }
    await this.tick();
  }
  async awaitIdle(): Promise<void> {
    while (this.#locks.size > 0) await Promise.all(this.#locks.values());
  }
  dispose(): void {
    this.#disposed = true;
    this.#authorized.clear();
    for (const entry of this.#controllers.values()) entry.controller.abort();
  }
  async #cleanup(scope: ThreadMessageQueueScope): Promise<void> {
    for (const resource of this.#retained.values())
      if (
        queueId(resource.scope) === queueId(scope) &&
        this.#store.identity(resource.messageId) === undefined
      )
        await this.#release(resource, "rollback");
    for (const content of this.#store.contents(scope)) {
      const identity = this.#store.identity(content.messageId);
      if (identity?.status === "removed") await this.#release(content, "removed", true);
      else if (
        identity?.status === "completed" ||
        identity?.status === "failed" ||
        identity?.status === "cancelled"
      )
        await this.#release(content, "accepted", true);
    }
  }
  async #release(
    content: ThreadMessageQueueResource,
    reason: "accepted" | "removed" | "purged" | "rollback",
    erase = false,
  ): Promise<boolean> {
    try {
      const released = await this.#port.release({ ...content, reason });
      if (released.status !== "released") return false;
      this.#retained.delete(content.messageId);
      if (erase) this.#store.deleteContent(content.messageId);
      return true;
    } catch {
      return false;
    }
  }
  #hold(state: QueueState, reason: ThreadMessageQueueHoldReason): void {
    if (!this.#disposed && state.holdReason !== reason)
      this.#store.write({ ...state, holdReason: reason });
  }
  async #inspect(
    input: Parameters<ThreadMessageQueueModePort["inspect"]>[0],
  ): Promise<ThreadMessageQueueInspection> {
    try {
      const inspected = await this.#port.inspect(input);
      return this.#disposed || this.#revoked.has(String(input.windowId))
        ? { status: "held", reason: "authority-revoked" }
        : inspected;
    } catch {
      return { status: "held", reason: "thread-unavailable" };
    }
  }
  async #serial<T>(scope: ThreadMessageQueueScope, body: () => Promise<T>): Promise<T> {
    const key = queueId(scope);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const operation = previous.then(body);
    const settled = operation.then(
      () => {},
      () => {},
    );
    this.#locks.set(key, settled);
    try {
      return await operation;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }
}
function authorization(
  windowId: WindowId,
  inspection: Exclude<ThreadMessageQueueInspection, { readonly status: "held" }>,
  scope: ThreadMessageQueueScope,
): LiveAuthorization {
  return {
    windowId,
    scope,
    ...(inspection.tail?.status === "failed" || inspection.tail?.status === "cancelled"
      ? { acknowledgedTail: inspection.tail.id }
      : {}),
  };
}
function validContent(content: QueueContent): boolean {
  if (
    content.binding.length === 0 ||
    Buffer.byteLength(content.binding) > 16 * 1024 ||
    Buffer.byteLength(JSON.stringify(content)) > MAX_THREAD_MESSAGE_QUEUE_ITEM_BYTES
  )
    return false;
  if (content.privateContextJson !== undefined) {
    if (
      Buffer.byteLength(content.privateContextJson) > MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES
    )
      return false;
    try {
      JSON.parse(content.privateContextJson);
    } catch {
      return false;
    }
  }
  return true;
}
function holdReason(reason: ThreadMessageQueueRefusalReason): ThreadMessageQueueHoldReason {
  if (reason === "unauthorized") return "authority-revoked";
  if (reason === "not-found") return "thread-unavailable";
  if (
    reason === "not-editable" ||
    reason === "invalid-order" ||
    reason === "queue-full" ||
    reason === "invalid-payload" ||
    reason === "storage-unavailable"
  )
    return "admission-refused";
  return reason;
}
const decodeTime = Schema.decodeUnknownSync(UtcTimestamp);
