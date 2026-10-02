/**
 * The host's one-shot recovery for a thread a provider stopped on a usage
 * limit. The person opted in on the exact stopped run; the record journals on
 * the thread's own aggregate; at the disclosed reset time the host re-checks
 * that nothing moved and admits a single continuation through the mode's
 * normal turn admission. Anything that moves the thread past the recorded
 * stop — a newer turn, an attempt that left `waiting`, a provider change, an
 * archive — settles the record invalidated rather than resuming a stop that
 * is no longer current.
 */
import { Schema } from "effect";
import {
  ActorId,
  CorrelationId,
  decodeAgentRunStatusChanged,
  decodeChatAttemptUpdated,
  decodeChatThreadUpdated,
  decodeChatTurnCreated,
  decodeCodeOperationEventFrame,
  decodeCodeThreadUpdated,
  decodeUsageResumeScheduled,
  decodeWorkTurnAccepted,
  decodeWorkTurnUpdated,
  EventId,
  USAGE_RESUME_CANCELLED,
  USAGE_RESUME_SCHEDULED,
  USAGE_RESUME_SETTLED,
  UtcTimestamp,
  WorkThreadUpdated,
  type CommittedAppend,
  type EventEnvelope,
  type UsageResumeRecord,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import {
  listPendingUsageResumes,
  type PendingUsageResume,
} from "../persistence/usageResumeProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdated);

export type UsageResumeSettledOutcome = "dispatched" | "invalidated" | "failed";

export type UsageResumeAggregateType = "chat-thread" | "work-thread" | "code-thread" | "agent-run";

/**
 * What the scheduler asks the mode at reset time. `inspect` re-reads the
 * opt-in's premise without side effects; `dispatch` admits the one
 * continuation and answers whether it landed.
 */
export interface UsageResumeModePort {
  readonly inspect: (
    record: UsageResumeRecord,
  ) => Promise<{ readonly kind: "ready" } | { readonly kind: "invalid"; readonly detail: string }>;
  readonly dispatch: (
    record: UsageResumeRecord,
  ) => Promise<
    | { readonly kind: "dispatched" }
    | { readonly kind: "refused"; readonly detail: string }
    | { readonly kind: "deferred"; readonly detail: string }
  >;
  /**
   * The thread row clients refresh through, rebuilt with the settle's
   * outcome already applied — the projection row it lands against only
   * exists after this append commits, so the mode re-reads its thread and
   * overrides the still-scheduled hydrate itself.
   */
  readonly settleUpdate?: (
    record: UsageResumeRecord,
    outcome: UsageResumeSettledOutcome,
    detail: string | undefined,
    nextVersion: number,
  ) => { readonly eventName: string; readonly payload: unknown } | undefined;
  /**
   * Applied after the settle append commits. Modes whose live state the
   * journal does not rebuild for them — the in-memory Work projection —
   * fold the settled record and the emitted thread row back in here; modes
   * that read a journaled projection need nothing.
   */
  readonly settleApplied?: (
    usageResumePayload: unknown,
    emitted: { readonly eventName: string; readonly payload: unknown } | undefined,
  ) => void;
}

export interface UsageResumePorts {
  readonly chat: UsageResumeModePort;
  readonly work: UsageResumeModePort;
  readonly code: UsageResumeModePort;
  readonly agentRun: UsageResumeModePort;
}

export type UsageResumeTimerHandle = unknown;

interface PendingResume {
  readonly aggregateType: UsageResumeAggregateType;
  readonly aggregateId: string;
  readonly record: UsageResumeRecord;
  timer: UsageResumeTimerHandle | undefined;
  dispatching: boolean;
}

interface UsageResumeServiceOptions {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly clock: () => Date;
  readonly uuid: () => string;
  readonly ports: UsageResumePorts;
  /** Injectable so tests drive the reset boundary by hand. */
  readonly schedule?: (atEpochMs: number, fire: () => void) => UsageResumeTimerHandle;
  readonly unschedule?: (handle: UsageResumeTimerHandle) => void;
  /** How long a deferred dispatch or a failed settle waits before re-arming. */
  readonly retryAfterMs?: number;
  /** Watches committed appends for schedule, cancel, and supersede events. */
  readonly onError?: (message: string, error: unknown) => void;
}

/**
 * `setTimeout` silently clamps a delay above 2^31-1 ms (about 24.8 days) to
 * one millisecond, so a further-out reset is armed in bounded chunks instead.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const DEFER_RETRY_AFTER_MS = 30_000;

const pendingKey = (aggregateType: string, aggregateId: string) =>
  `${aggregateType}::${aggregateId}`;

const asUsageResumeAggregateType = (aggregateType: string): UsageResumeAggregateType | undefined =>
  aggregateType === "chat-thread" ||
  aggregateType === "work-thread" ||
  aggregateType === "code-thread" ||
  aggregateType === "agent-run"
    ? aggregateType
    : undefined;

export class UsageResumeService {
  readonly #options: UsageResumeServiceOptions;
  readonly #pending = new Map<string, PendingResume>();

  constructor(options: UsageResumeServiceOptions) {
    this.#options = options;
  }

  /**
   * Rebuild the armed set from the projection. A resume whose reset passed
   * while the host was away evaluates on return; one that never re-arms is a
   * record the host could not interpret, so it settles invalidated instead of
   * silently hanging.
   */
  start(): void {
    for (const pending of listPendingUsageResumes(this.#options.connection)) {
      const aggregateType = asUsageResumeAggregateType(pending.aggregateType);
      if (aggregateType === undefined) continue;
      this.#arm({ aggregateType, aggregateId: pending.threadId, record: pending.record });
    }
  }

  stop(): void {
    for (const pending of this.#pending.values()) {
      this.#clearTimer(pending);
    }
    this.#pending.clear();
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      this.#onCommittedEvent(event);
    }
  }

  #onCommittedEvent(event: EventEnvelope): void {
    const aggregateType = asUsageResumeAggregateType(event.aggregateType);
    if (event.eventName === USAGE_RESUME_SCHEDULED) {
      if (aggregateType === undefined) return;
      try {
        const record = decodeUsageResumeScheduled(event.payload).resume;
        this.#arm({ aggregateType, aggregateId: event.aggregateId, record });
      } catch (error) {
        this.#options.onError?.("Usage-resume schedule event did not decode.", error);
      }
      return;
    }
    if (event.eventName === USAGE_RESUME_CANCELLED) {
      if (aggregateType === undefined) return;
      this.#drop(pendingKey(aggregateType, event.aggregateId));
      return;
    }
    if (event.eventName === USAGE_RESUME_SETTLED) {
      if (aggregateType === undefined) return;
      this.#drop(pendingKey(aggregateType, event.aggregateId));
      return;
    }
    this.#watchSupersede(event);
  }

  #watchSupersede(event: EventEnvelope): void {
    try {
      switch (event.eventName) {
        case "chat.thread-created@1":
          // A new thread can never carry the recorded stop.
          break;
        case "chat.thread-updated@1": {
          const pending = this.#pending.get(pendingKey("chat-thread", event.aggregateId));
          if (pending === undefined) break;
          const { thread } = decodeChatThreadUpdated(event.payload);
          if (thread.lifecycle !== "active") {
            void this.#invalidate(pending, "The thread is no longer active.");
          } else if (
            String(thread.providerInstanceId) !== String(pending.record.providerInstanceId)
          ) {
            void this.#invalidate(pending, "The thread's provider changed.");
          }
          break;
        }
        case "chat.turn-created@1": {
          const pending = this.#pending.get(pendingKey("chat-thread", event.aggregateId));
          if (pending === undefined) break;
          const { turn } = decodeChatTurnCreated(event.payload);
          if (String(turn.id) !== String(pending.record.turnId)) {
            void this.#invalidate(pending, "A newer turn started on the thread.");
          }
          break;
        }
        case "chat.attempt-updated@1": {
          const pending = this.#pending.get(pendingKey("chat-thread", event.aggregateId));
          if (pending === undefined) break;
          const { attempt } = decodeChatAttemptUpdated(event.payload);
          if (String(attempt.turnId) !== String(pending.record.turnId)) break;
          if (
            String(attempt.id) !== String(pending.record.attemptId) ||
            attempt.outcome !== "waiting" ||
            attempt.usageLimit === undefined
          ) {
            void this.#invalidate(
              pending,
              "The recorded stop is no longer the waiting usage-limited attempt.",
            );
          }
          break;
        }
        case "work.thread-updated@1": {
          const pending = this.#pending.get(pendingKey("work-thread", event.aggregateId));
          if (pending === undefined) break;
          const { thread } = decodeWorkThreadUpdated(event.payload);
          if (thread.lifecycle !== "active") {
            void this.#invalidate(pending, "The thread is no longer active.");
          } else if (
            String(thread.providerInstanceId) !== String(pending.record.providerInstanceId)
          ) {
            void this.#invalidate(pending, "The thread's provider changed.");
          }
          break;
        }
        case "work.turn-accepted@1": {
          const pending = this.#pending.get(pendingKey("work-thread", event.aggregateId));
          if (pending === undefined) break;
          const accepted = decodeWorkTurnAccepted(event.payload);
          if (String(accepted.turnId) !== String(pending.record.turnId)) {
            void this.#invalidate(pending, "A newer turn started on the thread.");
          }
          break;
        }
        case "work.turn-updated@1": {
          const pending = this.#pending.get(pendingKey("work-thread", event.aggregateId));
          if (pending === undefined) break;
          const updated = decodeWorkTurnUpdated(event.payload);
          if (
            String(updated.turnId) === String(pending.record.turnId) &&
            updated.status !== "waiting"
          ) {
            void this.#invalidate(pending, "The recorded turn left its waiting stop.");
          }
          break;
        }
        case "code.thread-updated@1": {
          const pending = this.#pending.get(pendingKey("code-thread", event.aggregateId));
          if (pending === undefined) break;
          const { thread } = decodeCodeThreadUpdated(event.payload);
          if (thread.lifecycle !== "active") {
            void this.#invalidate(pending, "The thread is no longer active.");
          } else if (
            String(thread.providerInstanceId) !== String(pending.record.providerInstanceId)
          ) {
            void this.#invalidate(pending, "The thread's provider changed.");
          }
          break;
        }
        case "agent.run-status-changed@1": {
          const pending = this.#pending.get(pendingKey("agent-run", event.aggregateId));
          if (pending === undefined) break;
          const payload = decodeAgentRunStatusChanged(event.payload);
          // The resume's own dispatch transitions the run out of waiting
          // while `dispatching` is still held, so only a transition that
          // arrives with the opt-in idle — a steer, a cancel, a settle, a
          // manual retry — supersedes it.
          if (payload.toStatus !== "waiting") {
            void this.#invalidate(pending, "The run left its waiting usage-limit stop.");
          } else if (
            payload.usageLimit === undefined ||
            payload.usageLimit.resetsAt !== pending.record.resetsAt
          ) {
            void this.#invalidate(
              pending,
              "The recorded stop is no longer the waiting usage-limit wait.",
            );
          }
          break;
        }
        case "code.operation-event-recorded@1": {
          // Provider turns journal on their own `code-operation` aggregate;
          // the frame names the thread so a new turn on a scheduled thread
          // still supersedes the recorded stop.
          const frame = decodeCodeOperationEventFrame(event.payload);
          const pending = this.#pending.get(pendingKey("code-thread", String(frame.threadId)));
          if (pending === undefined) break;
          if (
            frame.event.kind === "operation-result" &&
            frame.event.result.kind === "provider-turn-state"
          ) {
            void this.#invalidate(
              pending,
              "A provider turn ran on the thread after the recorded stop.",
            );
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.#options.onError?.("Usage-resume supersede watch failed to decode an event.", error);
    }
  }

  #arm(input: {
    readonly aggregateType: UsageResumeAggregateType;
    readonly aggregateId: string;
    readonly record: UsageResumeRecord;
  }): void {
    const key = pendingKey(input.aggregateType, input.aggregateId);
    const existing = this.#pending.get(key);
    if (existing !== undefined) {
      this.#clearTimer(existing);
    }
    const pending: PendingResume = {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      record: input.record,
      timer: undefined,
      dispatching: false,
    };
    this.#pending.set(key, pending);
    const at = Date.parse(input.record.resetsAt);
    if (Number.isNaN(at)) {
      // A reset that was never a time cannot re-arm later; settle honestly.
      void this.#settle(pending, "invalidated", "The recorded reset time is unreadable.");
      return;
    }
    if (at <= this.#options.clock().getTime()) {
      queueMicrotask(() => void this.#evaluate(key));
      return;
    }
    this.#armTimer(pending, at);
  }

  #armTimer(pending: PendingResume, atEpochMs: number): void {
    const schedule =
      this.#options.schedule ??
      ((at: number, fire: () => void) => setTimeout(fire, Math.max(0, at - Date.now())));
    const next = Math.min(atEpochMs, this.#options.clock().getTime() + MAX_TIMER_DELAY_MS);
    pending.timer = schedule(
      next,
      () => void this.#evaluate(pendingKey(pending.aggregateType, pending.aggregateId)),
    );
  }

  #retryAfterMs(): number {
    return this.#options.retryAfterMs ?? DEFER_RETRY_AFTER_MS;
  }

  #clearTimer(pending: PendingResume): void {
    if (pending.timer === undefined) return;
    const unschedule =
      this.#options.unschedule ??
      ((handle: UsageResumeTimerHandle) => clearTimeout(handle as never));
    unschedule(pending.timer);
    pending.timer = undefined;
  }

  #drop(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#clearTimer(pending);
    this.#pending.delete(key);
  }

  async #evaluate(key: string): Promise<void> {
    const pending = this.#pending.get(key);
    if (pending === undefined || pending.dispatching) return;
    pending.dispatching = true;
    pending.timer = undefined;
    const port = this.#portFor(pending.aggregateType);
    try {
      const at = Date.parse(pending.record.resetsAt);
      if (!Number.isNaN(at) && at > this.#options.clock().getTime()) {
        // A chunked wait fired early: re-arm for the rest of the reset rather
        // than inspecting against a limit that has not lifted yet.
        this.#armTimer(pending, at);
        return;
      }
      const verdict = await port.inspect(pending.record);
      if (verdict.kind === "invalid") {
        await this.#settle(pending, "invalidated", verdict.detail);
        return;
      }
      const result = await port.dispatch(pending.record);
      if (result.kind === "dispatched") {
        await this.#settle(pending, "dispatched");
      } else if (result.kind === "deferred") {
        // The opt-in is still valid but cannot fire yet — for example no
        // local window has registered since the host restarted. Keep it
        // armed and re-check on the retry cadence instead of settling.
        this.#armTimer(pending, this.#options.clock().getTime() + this.#retryAfterMs());
      } else {
        await this.#settle(pending, "failed", result.detail);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The dispatch threw.";
      await this.#settle(pending, "failed", detail);
    } finally {
      pending.dispatching = false;
    }
  }

  async #invalidate(pending: PendingResume, detail: string): Promise<void> {
    if (pending.dispatching) return;
    pending.dispatching = true;
    try {
      await this.#settle(pending, "invalidated", detail);
    } finally {
      pending.dispatching = false;
    }
  }

  async #settle(
    pending: PendingResume,
    outcome: UsageResumeSettledOutcome,
    detail?: string,
  ): Promise<void> {
    // Settle details surface to the person and sit in the journal forever;
    // raw internal error text arrives unbounded, so bound what is kept.
    const normalizedDetail =
      detail === undefined ? undefined : detail.trim().slice(0, 512).trim() || undefined;
    const expectedVersion = readAggregateVersion(
      this.#options.connection,
      pending.aggregateType,
      pending.aggregateId,
    );
    const port = this.#portFor(pending.aggregateType);
    let threadUpdate: { readonly eventName: string; readonly payload: unknown } | undefined;
    try {
      threadUpdate = port.settleUpdate?.(
        pending.record,
        outcome,
        normalizedDetail,
        expectedVersion + 2,
      );
    } catch (error) {
      this.#options.onError?.("Usage-resume settle could not rebuild the thread update.", error);
    }
    const settledPayload = {
      resume: pending.record,
      outcome,
      ...(normalizedDetail === undefined ? {} : { detail: normalizedDetail }),
    };
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: pending.aggregateType,
          aggregateId: pending.aggregateId,
        },
        expectedVersion,
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: USAGE_RESUME_SETTLED,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: decodeTimestamp(this.#options.clock().toISOString()),
            payload: settledPayload,
          },
          ...(threadUpdate === undefined
            ? []
            : [
                {
                  eventId: decodeEventId(this.#options.uuid()),
                  eventName: threadUpdate.eventName,
                  eventVersion: 1,
                  hostId: LOCAL_HOST_ID,
                  correlationId: decodeCorrelationId(this.#options.uuid()),
                  actor: {
                    kind: "system" as const,
                    actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
                  },
                  occurredAt: decodeTimestamp(this.#options.clock().toISOString()),
                  payload: threadUpdate.payload,
                },
              ]),
        ],
      });
    } catch (error) {
      // The durable opt-in is still armed: dropping the pending entry here
      // would strand it until the next restart, so keep it and re-try the
      // settlement on the retry cadence.
      this.#options.onError?.("Usage-resume settle append failed.", error);
      this.#armTimer(pending, this.#options.clock().getTime() + this.#retryAfterMs());
      return;
    }
    this.#pending.delete(pendingKey(pending.aggregateType, pending.aggregateId));
    try {
      port.settleApplied?.(settledPayload, threadUpdate);
    } catch (error) {
      this.#options.onError?.("Usage-resume settle could not update the live mode state.", error);
    }
  }

  #portFor(aggregateType: UsageResumeAggregateType): UsageResumeModePort {
    switch (aggregateType) {
      case "chat-thread":
        return this.#options.ports.chat;
      case "work-thread":
        return this.#options.ports.work;
      case "code-thread":
        return this.#options.ports.code;
      case "agent-run":
        return this.#options.ports.agentRun;
    }
  }
}

export type { PendingUsageResume };
