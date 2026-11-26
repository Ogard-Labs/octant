import { randomUUID } from "node:crypto";
import {
  UtcTimestamp,
  decodeAggregateVersion,
  decodeCodeOperationId,
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
  type ThreadMessageQueueSnapshot,
  type ThreadQueueMessageId,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { isRoutineHostScope } from "../routineHostScope";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES,
  queueHoldReason,
  type ThreadMessageQueueModePort,
  type ThreadMessageQueueResource,
  type ThreadMessageQueueInspection,
} from "./threadMessageQueuePort";
import {
  CONTINUED_PAST_RESTART,
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
  /**
   * Whether a scope is a device the host's own person did not pair: one the
   * hub's roster introduced, or an unproved pairing. Such a device queues a
   * message and edits or removes its own; pausing, resuming and reordering
   * the queue, and another's message, stay with the host's own person, at a
   * window here or on a device they paired (maintainer decision, 2026-11-13).
   */
  readonly isRestrictedDevice?: (scopeId: WindowId) => boolean;
  /**
   * The actor a command from a device's scope is journaled with, so a
   * device's change names the device. Undefined for a window, whose change
   * is journaled with `actor`.
   */
  readonly deviceActor?: (scopeId: WindowId) => EventActor | undefined;
  /**
   * Told that a message started or stopped waiting on a running turn's
   * runtime. That is host memory, not a journaled change, so without this a
   * reader would keep offering edit and remove on it until its next read.
   */
  readonly onSteeringChanged?: () => void;
}
/**
 * Whether a thread owes a turn. `active` is a turn its mode is running or has
 * queued, or a message still in this queue, whether the queue is moving,
 * paused, or held. `unconfirmed` is a last turn that ended without the host
 * learning how. `unavailable` is a thread this window cannot read.
 */
export type ThreadTurnStanding = "idle" | "active" | "unconfirmed" | "unavailable";
interface LiveAuthorization {
  readonly windowId: WindowId;
  readonly scope: ThreadMessageQueueScope;
  readonly acknowledgedTail?: string;
}
export class ThreadMessageQueueService {
  readonly #store: ThreadMessageQueuePersistence;
  readonly #port: ThreadMessageQueueModePort;
  readonly #clock: () => string;
  readonly #isRestrictedDevice: (scopeId: WindowId) => boolean;
  readonly #deviceActor: (scopeId: WindowId) => EventActor | undefined;
  readonly #onSteeringChanged: () => void;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #pendingTicks = new Set<string>();
  #allScopesTick: Promise<void> | undefined;
  readonly #authorized = new Map<string, LiveAuthorization>();
  readonly #retained = new Map<string, ThreadMessageQueueResource>();
  readonly #controllers = new Map<
    string,
    { readonly windowId: WindowId; readonly controller: AbortController }
  >();
  readonly #revoked = new Set<string>();
  readonly #purging = new Set<string>();
  /** Messages a running turn's runtime refused to take; each waits for a turn of its own. */
  readonly #unsteerable = new Set<string>();
  /**
   * Messages offered to a running turn whose runtime has not answered yet.
   * Each stays queued but is neither dispatched, edited, removed, nor moved
   * until the runtime answers, so it can never reach two turns.
   */
  readonly #steering = new Set<string>();
  /**
   * Of those, the messages a running turn's runtime is actually being asked
   * to take. Readers see and are told about only these: the queue's
   * once-a-second pass offers a message the port rules out at once (a Chat
   * turn, a runtime that cannot steer), and announcing every such offer made
   * each open queue panel read unchanged data every second.
   */
  readonly #asking = new Set<string>();
  #disposed = false;
  constructor(options: ThreadMessageQueueServiceOptions) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#store = new ThreadMessageQueuePersistence({ ...options, clock: this.#clock });
    this.#port = options.port;
    this.#isRestrictedDevice = options.isRestrictedDevice ?? (() => false);
    this.#deviceActor = options.deviceActor ?? (() => undefined);
    this.#onSteeringChanged = options.onSteeringChanged ?? (() => undefined);
  }
  /** The queue as stored, with each message a running turn's runtime is still considering marked. */
  #snapshot(scope: ThreadMessageQueueScope): ThreadMessageQueueSnapshot {
    const stored = this.#store.snapshot(scope);
    if (!stored.items.some((item) => this.#asking.has(item.messageId))) return stored;
    return {
      ...stored,
      items: stored.items.map((item) =>
        this.#asking.has(item.messageId) ? { ...item, steering: true as const } : item,
      ),
    };
  }
  async read(
    windowId: WindowId,
    scope: ThreadMessageQueueScope,
  ): Promise<ThreadMessageQueueReadResult> {
    const inspected = await this.#inspect({ scope, windowId, intent: "read" });
    if (inspected.status === "held") return { status: "refused", reason: inspected.reason };
    if (this.#store.purged(scope)) return { status: "refused", reason: "thread-unavailable" };
    return { status: "ready", snapshot: this.#snapshot(scope) };
  }
  /**
   * Tells a caller that must act only on an idle thread where the thread
   * stands, and runs `act` under this thread's queue ordering, so no enqueue,
   * resume, or dispatch lands between the answer and what is done with it.
   * The mode alone cannot answer: it sees the turns it admitted, not a message
   * waiting here behind a pause or a hold.
   *
   * A caller that will send the thread a message asks with intent
   * `dispatch`, so a thread that takes no new message (archived, completed,
   * marked Done, or without its checkout) reads as unavailable, as it would
   * for a queued message.
   */
  async withTurnStanding<T>(
    windowId: WindowId,
    scope: ThreadMessageQueueScope,
    act: (standing: ThreadTurnStanding) => T | Promise<T>,
    intent: "read" | "dispatch" = "read",
  ): Promise<T> {
    return this.#serial(scope, async () => {
      const inspection = await this.#inspect({ scope, windowId, intent });
      if (
        inspection.status === "held" ||
        this.#purging.has(queueId(scope)) ||
        this.#store.purged(scope)
      )
        return act("unavailable");
      if (inspection.status === "busy" || this.#store.state(scope).items.length > 0)
        return act("active");
      return act(inspection.tail?.unconfirmed === true ? "unconfirmed" : "idle");
    });
  }
  /**
   * Whether a message waits in the thread's queue. The host asks this for its
   * own housekeeping, with no window involved, so it reads the stored queue
   * and nothing else.
   */
  hasQueued(scope: ThreadMessageQueueScope): boolean {
    return this.#store.state(scope).items.length > 0;
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
      const refused = (
        reason: ThreadMessageQueueRefusalReason,
        message?: string,
      ): ThreadMessageQueueResult => ({
        status: "refused",
        requestId: command.requestId,
        reason,
        ...(message === undefined ? {} : { message }),
      });
      const result = (status: "applied" | "duplicate" | "conflict"): ThreadMessageQueueResult => ({
        status,
        requestId: command.requestId,
        snapshot: this.#snapshot(command.scope),
      });
      if (this.#disposed) return refused("authority-revoked");
      const deviceActor = this.#deviceActor(windowId);
      const actor = deviceActor === undefined ? {} : { actor: deviceActor };
      const receipt = this.#store.receipt(command.requestId);
      const previous =
        command.kind === "enqueue" ? this.#store.identity(command.messageId) : undefined;
      const inspection = await this.#inspect({
        scope: command.scope,
        windowId,
        // A retry observes the committed receipt even if the thread since completed.
        // Read authority is still required; this does not renew dispatch authority.
        intent: receipt !== undefined || previous !== undefined ? "read" : command.kind,
        ...(command.kind === "enqueue" ? { payload: command.payload } : {}),
      });
      if (inspection.status === "held") return refused(inspection.reason, inspection.message);
      if (this.#purging.has(queueId(command.scope)) || this.#store.purged(command.scope))
        return refused("thread-unavailable");
      const id = queueId(command.scope);
      if (receipt !== undefined)
        return receipt.queue_id === id && receipt.fingerprint === queueFingerprint(command)
          ? result("duplicate")
          : refused("invalid-payload");
      if (command.kind === "enqueue") {
        if (previous !== undefined)
          return previous.queue_id === id &&
            previous.fingerprint ===
              queueFingerprint({ scope: command.scope, payload: command.payload })
            ? result("duplicate")
            : refused("invalid-payload");
      }
      const state = this.#store.state(command.scope);
      if (this.#isRestrictedDevice(windowId)) {
        if (command.kind === "pause" || command.kind === "resume" || command.kind === "reorder")
          return refused("unauthorized");
        if (
          (command.kind === "edit" || command.kind === "remove" || command.kind === "send-now") &&
          state.items.some(
            (item) =>
              String(item.messageId) === String(command.messageId) &&
              String(item.queuedBy) !== String(windowId),
          )
        )
          return refused("unauthorized");
      }
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
                queuedBy: windowId,
                ...(command.timing === "next-turn" ? { waitsForNextTurn: true as const } : {}),
              },
            ],
          },
          { command, ...actor, content },
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
        if (item.status !== "queued" || this.#steering.has(item.messageId))
          return refused("not-editable");
        const content = this.#store.content(item.messageId);
        if (command.kind === "edit") {
          if (content === undefined) return refused("content-unavailable");
          let updated: QueueContent;
          try {
            // A save that changes nothing keeps the claim the message had and
            // gives none. A changed message keeps a claim only when it already
            // had one and the person's own route made it again with the edit;
            // an edit never gives a message the claim (an agent's text, a
            // template), and any other edit leaves it as not typed.
            const { typedByPerson: earlier, ...kept } = content.payload;
            const typed =
              earlier === true &&
              (command.prompt === content.payload.prompt || command.typedByPerson === true);
            updated = {
              ...content,
              payload: decodeThreadMessageQueuePayload({
                ...kept,
                prompt: command.prompt,
                ...(typed ? { typedByPerson: true } : {}),
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
            { command, ...actor, content: updated },
          );
          if (outcome === "applied" && this.#retained.has(item.messageId))
            this.#retained.set(item.messageId, updated);
          return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
        }
        const outcome = this.#store.write(
          { ...state, items: state.items.filter((value) => value !== item) },
          { command, ...actor, settled: { messageId: item.messageId, status: "removed" } },
        );
        if (outcome === "applied") {
          this.#authorized.delete(item.messageId);
          this.#unsteerable.delete(item.messageId);
          if (content !== undefined) await this.#release(content, "removed", true);
        }
        return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
      }
      if (command.kind === "send-now") {
        // The person's own press: the message goes to the front of what can
        // still move and may steer the running turn, through the same checks
        // as any message. A pause or a hold stays the person's to lift first.
        if (state.paused) return refused("paused");
        if (state.holdReason !== undefined) return refused(state.holdReason);
        const item = state.items.find(
          (value) => String(value.messageId) === String(command.messageId),
        );
        if (item === undefined) return refused("not-found");
        if (item.status !== "queued" || this.#steering.has(item.messageId))
          return refused("not-editable");
        const { waitsForNextTurn: _waits, ...rest } = item;
        const sent = { ...rest, revision: decodeAggregateVersion(item.revision + 1) };
        const others = state.items.filter((value) => value !== item);
        // Messages already on their way, or offered to the turn, keep their place.
        const fixed = others.findIndex(
          (value) => value.status === "queued" && !this.#steering.has(value.messageId),
        );
        const at = fixed < 0 ? others.length : fixed;
        const outcome = this.#store.write(
          { ...state, items: [...others.slice(0, at), sent, ...others.slice(at)] },
          { command, ...actor },
        );
        // A runtime that would not take it before is asked again on this press.
        if (outcome === "applied") this.#unsteerable.delete(item.messageId);
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
        if (
          state.items.some(
            (item, index) =>
              (item.status !== "queued" || this.#steering.has(item.messageId)) &&
              defined[index] !== item,
          )
        )
          return refused("not-editable");
        const outcome = this.#store.write({ ...state, items: defined }, { command, ...actor });
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
        const {
          holdReason: _hold,
          continuedPast: _continuedPast,
          liftsAfterRestart: _lifts,
          ...withoutHold
        } = state;
        // The host releasing a queue behind its own restart continuation
        // reviewed nothing: the queue has continued past that restart, so a
        // failure or another restart before a turn completes holds it, and
        // each message keeps the window that queued it.
        const outcome = this.#store.write(
          isRoutineHostScope(windowId)
            ? { ...withoutHold, paused: false, continuedPast: CONTINUED_PAST_RESTART }
            : // A person looked: the queue may again pass one failure by itself,
              // and every message now waits under the window that resumed it.
              {
                ...withoutHold,
                paused: false,
                items: state.items.map((item) => ({ ...item, queuedBy: windowId })),
              },
          { command, ...actor },
        );
        if (outcome === "applied")
          for (const [key, value] of authorizations) this.#authorized.set(key, value);
        return outcome === "unavailable" ? refused("storage-unavailable") : result(outcome);
      }
      const outcome = this.#store.write(
        { ...state, paused: true, holdReason: "paused" },
        { command, ...actor },
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
        if (state.items.length > 0) {
          const unavailable = failures.has(queueId(scope));
          // A queue still waiting out an earlier clean restart stays as it is:
          // it has not continued, and a repeated start-up appends nothing.
          const waiting = state.holdReason === "host-restart" && state.liftsAfterRestart === true;
          // Clean means the restart cut nothing of this queue: no delivery was
          // in flight, nobody had paused or held it, and it has not already
          // continued by itself since a turn last completed.
          const clean =
            !unavailable &&
            !state.paused &&
            state.holdReason === undefined &&
            state.continuedPast === undefined &&
            state.items.every((item) => item.status === "queued" && item.queuedBy !== undefined);
          if (unavailable || !waiting) {
            const { liftsAfterRestart: _lifts, ...rest } = state;
            const reason = unavailable ? "content-unavailable" : "host-restart";
            if (clean) this.#store.write({ ...rest, holdReason: reason, liftsAfterRestart: true });
            else if (state.liftsAfterRestart === true)
              this.#store.write({ ...rest, holdReason: reason });
            else this.#hold(state, reason);
          }
        }
        await this.#cleanup(scope);
      });
  }
  async tick(scope?: ThreadMessageQueueScope): Promise<void> {
    if (this.#disposed) return;
    if (scope !== undefined) {
      await this.#tickScopes([scope]);
      return;
    }
    if (this.#allScopesTick !== undefined) return this.#allScopesTick;
    // Install the promise before reading: several timer/journal wakes in the
    // same turn must not each scan and decode every pending queue.
    const discovery = Promise.resolve().then(() =>
      this.#disposed
        ? []
        : [
            ...new Map(
              [
                ...this.#store.scopes(),
                ...[...this.#retained.values()].map((resource) => resource.scope),
              ].map((current) => [queueId(current), current]),
            ).values(),
          ],
    );
    const pass = discovery.then((scopes) => this.#tickScopes(scopes));
    // Coalescing ends with discovery. A Chat admission resolves only when its
    // turn is accepted, so sharing the whole pass would let one slow queue
    // stall the next recovery tick for every other queue; #pendingTicks and
    // #serial keep a still-running queue from being driven twice.
    const settled = () => {
      if (this.#allScopesTick === pass) this.#allScopesTick = undefined;
    };
    discovery.then(settled, settled);
    this.#allScopesTick = pass;
    return pass;
  }
  async #tickScopes(scopes: ReadonlyArray<ThreadMessageQueueScope>): Promise<void> {
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
        reconciled = await this.#port.reconcile({
          scope,
          messageId: head.messageId,
          ...(head.codeOperationId === undefined ? {} : { codeOperationId: head.codeOperationId }),
        });
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
        // The running turn is the head's own: a message this queue admitted
        // stays at the head until its turn settles, and the next one may
        // still be steered into it.
        await this.#steerBehindAccepted(scope);
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
      // An ordinary failure is judged where the next message is dispatched,
      // against the failure this queue may already have continued past.
      const ordinary = terminal === "failed" && reconciled.ordinaryFailure === true;
      const { continuedPast: _continuedPast, ...completedState } = state;
      const outcome = this.#store.write(
        {
          ...(terminal === "completed" ? completedState : state),
          items: state.items.slice(1),
          ...(terminal === "completed" || ordinary ? {} : { holdReason: terminal }),
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
    if (
      head !== undefined &&
      !state.paused &&
      state.holdReason === "host-restart" &&
      state.liftsAfterRestart === true &&
      !this.#disposed
    ) {
      const lifted = await this.#liftRestartHold(scope, state);
      if (lifted === undefined) return;
      state = lifted;
      head = state.items[0];
    }
    if (
      head === undefined ||
      state.paused ||
      state.holdReason !== undefined ||
      this.#disposed ||
      this.#steering.has(head.messageId)
    )
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
      this.#hold(state, queueHoldReason(inspection.reason));
      return;
    }
    if (inspection.binding !== content.binding) {
      this.#hold(state, "binding-changed");
      return;
    }
    if (
      inspection.tail &&
      (inspection.tail.status === "cancelled" || inspection.tail.status === "failed") &&
      inspection.tail.id !== auth.acknowledgedTail &&
      inspection.tail.id !== state.continuedPast
    ) {
      // The queue passes one ordinary failure by itself. A second in a row,
      // or one that follows a restart it already continued past, holds it.
      if (inspection.tail.ordinaryFailure !== true || state.continuedPast !== undefined) {
        this.#hold(state, inspection.tail.status);
        return;
      }
      if (this.#store.write({ ...state, continuedPast: inspection.tail.id }) !== "applied") return;
      state = this.#store.state(scope);
      head = state.items[0];
      if (head === undefined) return;
    } else if (
      inspection.tail?.status === "completed" &&
      state.continuedPast !== undefined &&
      // A tail that completed before the restart says nothing about the
      // continuation after it; only the settling of a message this queue
      // dispatched since then restores that allowance.
      state.continuedPast !== CONTINUED_PAST_RESTART
    ) {
      const { continuedPast: _continuedPast, ...rest } = state;
      if (this.#store.write(rest) !== "applied") return;
      state = this.#store.state(scope);
      head = state.items[0];
      if (head === undefined) return;
    }
    if (inspection.status === "busy") {
      // A message the person chose to queue waits for the next turn.
      if (head.waitsForNextTurn !== true)
        this.#steer(scope, head.messageId, content, auth.windowId);
      return;
    }
    this.#unsteerable.delete(head.messageId);
    const codeOperationId = scope.mode === "code" ? decodeCodeOperationId(randomUUID()) : undefined;
    if (
      this.#store.write({
        ...state,
        items: state.items.map((item) =>
          item === head
            ? {
                ...item,
                status: "dispatching",
                ...(codeOperationId === undefined ? {} : { codeOperationId }),
              }
            : item,
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
        ...(codeOperationId === undefined ? {} : { codeOperationId }),
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
  /**
   * Offers the message behind the head to the running turn when that turn is
   * the head's own, which this queue admitted. Only that one message is
   * offered, under the same pause, hold, authority and binding checks as the
   * head, so the queue's order holds. A check that fails leaves it for the
   * head's ordinary dispatch to judge, and holds nothing.
   */
  async #steerBehindAccepted(scope: ThreadMessageQueueScope): Promise<void> {
    const state = this.#store.state(scope);
    const next = state.items[1];
    if (
      this.#port.steer === undefined ||
      next === undefined ||
      next.status !== "queued" ||
      next.waitsForNextTurn === true ||
      state.paused ||
      state.holdReason !== undefined ||
      this.#disposed ||
      this.#unsteerable.has(next.messageId) ||
      this.#steering.has(next.messageId)
    )
      return;
    const content = this.#store.content(next.messageId);
    const auth = this.#authorized.get(next.messageId);
    if (content === undefined || auth === undefined) return;
    const inspection = await this.#inspect({
      scope,
      windowId: auth.windowId,
      intent: "dispatch",
      payload: content.payload,
    });
    if (this.#disposed || !this.#authorized.has(next.messageId)) return;
    if (inspection.status !== "busy" || inspection.binding !== content.binding) return;
    this.#steer(scope, next.messageId, content, auth.windowId);
  }
  /**
   * Hands one message to the turn already running, where its runtime steers.
   * A message that cannot be steered keeps every later one behind it in
   * order. The message is not marked as dispatching: a restart while the
   * runtime takes it also ends the turn that took it, and the message still
   * queued is then sent again under the ordinary restart rules rather than
   * lost.
   *
   * The runtime is asked outside this queue's lock. Octant Harness answers
   * only once the note is in the conversation, at the end of the step that is
   * running, and a step can wait on a tool approval for as long as the
   * person takes; holding the lock that long would stop them queuing,
   * pausing, or removing anything else meanwhile.
   */
  #steer(
    scope: ThreadMessageQueueScope,
    messageId: ThreadQueueMessageId,
    content: QueueContent,
    windowId: WindowId,
  ): void {
    const steer = this.#port.steer;
    if (steer === undefined || this.#unsteerable.has(messageId) || this.#steering.has(messageId))
      return;
    this.#steering.add(messageId);
    const asking = () => {
      if (this.#disposed || !this.#steering.has(messageId) || this.#asking.has(messageId)) return;
      this.#asking.add(messageId);
      this.#steeringChanged();
    };
    void (async () => {
      let outcome: "steered" | "refused" | "unavailable";
      try {
        outcome = await steer({ scope, messageId, payload: content.payload, windowId, asking });
      } catch {
        outcome = "refused";
      }
      await this.#serial(scope, () => this.#settleSteer(scope, messageId, content, outcome));
    })().catch(() => {
      this.#steering.delete(messageId);
      if (this.#asking.delete(messageId)) this.#steeringChanged();
    });
  }
  #steeringChanged(): void {
    try {
      this.#onSteeringChanged();
    } catch {
      // A reader that missed the notice catches up at its next read.
    }
  }
  async #settleSteer(
    scope: ThreadMessageQueueScope,
    messageId: ThreadQueueMessageId,
    content: QueueContent,
    outcome: "steered" | "refused" | "unavailable",
  ): Promise<void> {
    this.#steering.delete(messageId);
    // A steered message's removal is journaled and notifies by itself; one
    // that waits again changes nothing durable, and one never announced
    // changes nothing a reader saw.
    if (this.#asking.delete(messageId) && outcome !== "steered") this.#steeringChanged();
    if (this.#disposed) return;
    // Nothing was tried (the turn is still starting, say), so a later pass
    // asks again; asking now would only repeat the same answer.
    if (outcome === "unavailable") return;
    // A runtime that would not take this message is not asked again for it:
    // the recovery pass runs every second and would otherwise ask each time.
    if (outcome === "refused") this.#unsteerable.add(messageId);
    if (outcome === "steered") {
      const state = this.#store.state(scope);
      // Edits and removal wait while the runtime is asked, so the message is
      // still queued unless the thread was purged meanwhile.
      if (state.items.some((item) => String(item.messageId) === String(messageId))) {
        const written = this.#store.write(
          {
            ...state,
            items: state.items.filter((item) => String(item.messageId) !== String(messageId)),
          },
          { settled: { messageId, status: "steered" } },
        );
        if (written === "applied") {
          this.#authorized.delete(messageId);
          await this.#release(content, "accepted", true);
        }
      }
    }
    // The next message may be steered too, or, when the turn ended before
    // its runtime took this one, sent as a turn of its own.
    await this.#tick(scope);
  }
  /**
   * Lifts the hold a clean restart left, once, under the authority each
   * message was queued with. Every message is rechecked as an explicit resume
   * rechecks it; a window that is not back yet leaves the hold in place for a
   * later pass, and any other refusal ends the wait so a person decides.
   * Nothing is acknowledged here: a turn the restart cut off still holds.
   */
  async #liftRestartHold(
    scope: ThreadMessageQueueScope,
    state: QueueState,
  ): Promise<QueueState | undefined> {
    const { liftsAfterRestart: _lifts, ...settled } = state;
    const authorizations = new Map<string, LiveAuthorization>();
    for (const item of state.items) {
      const content = this.#store.content(item.messageId);
      if (content === undefined || item.queuedBy === undefined) {
        this.#store.write({ ...settled, holdReason: "content-unavailable" });
        return undefined;
      }
      const current = await this.#inspect({
        scope,
        windowId: item.queuedBy,
        intent: "resume",
        payload: content.payload,
      });
      if (this.#disposed) return undefined;
      if (current.status === "held") {
        if (current.reason !== "authority-revoked")
          this.#store.write({ ...settled, holdReason: queueHoldReason(current.reason) });
        return undefined;
      }
      if (current.binding !== content.binding) {
        this.#store.write({ ...settled, holdReason: "binding-changed" });
        return undefined;
      }
      authorizations.set(item.messageId, { windowId: item.queuedBy, scope });
    }
    const { holdReason: _hold, ...lifted } = settled;
    if (this.#store.write({ ...lifted, continuedPast: CONTINUED_PAST_RESTART }) !== "applied")
      return undefined;
    for (const [key, value] of authorizations) this.#authorized.set(key, value);
    return this.#store.state(scope);
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
    const changed = new Map<string, ThreadMessageQueueScope>();
    for (const event of append.events) {
      if (event.eventVersion !== 1) continue;
      const wakeScope = queueScopeForEvent(event);
      if (wakeScope !== undefined) changed.set(queueId(wakeScope), wakeScope);
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
      // Cleanup for the purged scope stays unconditional: its queue still
      // gets a pass even though no event names it.
      changed.set(queueId(scope), scope);
    }
    await Promise.all([...changed.values()].map((scope) => this.tick(scope)));
  }
  async awaitIdle(): Promise<void> {
    while (this.#allScopesTick !== undefined || this.#locks.size > 0) {
      await Promise.all([
        ...(this.#allScopesTick === undefined ? [] : [this.#allScopesTick.catch(() => undefined)]),
        ...this.#locks.values(),
      ]);
    }
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
        identity?.status === "steered" ||
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
const decodeTime = Schema.decodeUnknownSync(UtcTimestamp);

function eventField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The queue a committed event names, when it says something a dispatcher
 * cares about. Payloads already crossed schema validation, so only the
 * discriminator and thread identity are read; ordinary streaming deltas and
 * unrelated journal writes mean no wake.
 */
function queueScopeForEvent(
  event: CommittedAppend["events"][number],
): ThreadMessageQueueScope | undefined {
  const payload = event.payload;
  const scope = (
    mode: ThreadMessageQueueScope["mode"],
    threadId: unknown,
  ): ThreadMessageQueueScope | undefined =>
    typeof threadId === "string" ? decodeThreadMessageQueueScope({ mode, threadId }) : undefined;
  switch (event.eventName) {
    case "thread.message-queue-changed@1": {
      const current = eventField(eventField(payload, "state"), "scope");
      return current === undefined ? undefined : decodeThreadMessageQueueScope(current);
    }
    case "chat.thread-created@1":
    case "chat.thread-updated@1":
    case "chat.thread-rewound@1":
      return scope("chat", eventField(eventField(payload, "thread"), "id"));
    case "chat.turn-created@1":
      return scope("chat", eventField(eventField(payload, "turn"), "threadId"));
    case "chat.attempt-updated@1": {
      const attempt = eventField(payload, "attempt");
      const outcome = eventField(attempt, "outcome");
      return outcome === "completed" ||
        outcome === "failed" ||
        outcome === "interrupted" ||
        outcome === "cancelled"
        ? scope("chat", eventField(attempt, "threadId"))
        : undefined;
    }
    case "work.thread-created@1":
    case "work.thread-updated@1":
    case "work.thread-completion-confirmed@1":
      return scope("work", eventField(eventField(payload, "thread"), "id"));
    case "work.turn-accepted@1":
      return scope("work", eventField(payload, "threadId"));
    case "work.turn-updated@1": {
      const status = eventField(payload, "status");
      // A fork's carried copy of a source turn is not a turn that settled here.
      if (eventField(payload, "carried") === true) return undefined;
      return status === "completed" || status === "cancelled" || status === "failed"
        ? scope("work", eventField(payload, "threadId"))
        : undefined;
    }
    case "code.thread-created@1":
    case "code.thread-updated@1":
      return scope("code", eventField(eventField(payload, "thread"), "id"));
    case "code.runtime-work-updated@1": {
      const work = eventField(payload, "work");
      const state = eventField(work, "state");
      return state === "completed" ||
        state === "failed" ||
        state === "interrupted" ||
        state === "ambiguous"
        ? scope("code", eventField(work, "threadId"))
        : undefined;
    }
    case "code.operation-event-recorded@1": {
      const frame = eventField(payload, "event");
      const kind = eventField(frame, "kind");
      const state = eventField(frame, "state");
      return kind === "operation-result" ||
        (kind === "operation-state" &&
          (state === "completed" || state === "failed" || state === "interrupted"))
        ? scope("code", eventField(payload, "threadId"))
        : undefined;
    }
    case "context.compaction-completed@1":
    case "context.compaction-failed@1": {
      const subject = eventField(
        event.eventName === "context.compaction-completed@1"
          ? eventField(payload, "receipt")
          : payload,
        "subject",
      );
      const kind = eventField(subject, "aggregateType");
      const id = eventField(subject, "aggregateId");
      return kind === "chat-thread"
        ? scope("chat", id)
        : kind === "work-thread"
          ? scope("work", id)
          : kind === "code-thread"
            ? scope("code", id)
            : undefined;
    }
    default:
      return undefined;
  }
}
