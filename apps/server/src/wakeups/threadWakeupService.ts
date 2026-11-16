/**
 * Wake-ups a thread's agent asks for, owned by the host. The agent's runtime
 * keeps no schedule of its own: its driver hands each request here through
 * the session's {@link ProviderWakeupSchedule}, and this service journals it
 * on its own `thread-wakeup` aggregate, lists it for the thread, lets the
 * person cancel it, and starts the thread's turn when it comes due, through
 * the same host-turn path a message wake takes, at the thread's own level.
 *
 * Nothing fires unseen. A wake-up that came due while the host was down, or
 * while its timer was held back past the grace window, is journaled as
 * missed and waits for the person to run or cancel it. A thread archived or
 * deleted ends every wake-up it had; a purged thread's wake-ups leave with
 * its events, and nothing new is journaled for them.
 */
import { Schema } from "effect";
import {
  ActorId,
  CorrelationId,
  DEFAULT_THREAD_WAKEUPS_WAITING,
  decodeCodeThreadUpdated,
  decodeThreadRetentionThreadPurged,
  decodeThreadWakeupChanged,
  decodeThreadWakeupId,
  EventId,
  THREAD_RETENTION_EVENT_NAMES,
  THREAD_WAKEUP_AGGREGATE,
  THREAD_WAKEUP_CHANGED,
  THREAD_WAKEUP_TURN_HEADING,
  UtcTimestamp,
  WorkThreadUpdated,
  type EventActor,
  type EventEnvelope,
  type ThreadWakeup,
  type ThreadWakeupChanged,
  type ThreadWakeupCommandResult,
  type ThreadWakeupEndedReason,
  type ThreadWakeupMode,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  admitThreadWakeup,
  describeThreadWakeup,
  nextThreadWakeupFire,
  planCronWakeup,
  planDelayedWakeup,
  threadWakeupDue,
} from "@octant/domain/thread-wakeup-policy";
import type {
  ProviderWakeup,
  ProviderWakeupRequest,
  ProviderWakeupSchedule,
} from "@octant/provider-sdk";
import type { Journal } from "../persistence/journal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeWorkThreadUpdated = Schema.decodeUnknownSync(WorkThreadUpdated);

/** What the service asks a mode when a wake-up comes due. */
export interface ThreadWakeupModePort {
  /** Whether the thread still exists, active, in its Project. */
  readonly threadOpen: (threadId: string) => boolean;
  /**
   * Starts one host turn in the thread at its own level with this prompt,
   * through the ordinary turn admission. `busy` means a turn is running or
   * waiting on the person there, so the wake-up is offered again after it.
   */
  readonly startTurn: (
    threadId: string,
    prompt: string,
  ) => Promise<
    | { readonly status: "started"; readonly turnId: string }
    | { readonly status: "busy" }
    | { readonly status: "refused"; readonly message: string }
  >;
}

export type ThreadWakeupTimerHandle = unknown;

/**
 * Where Work and Code session starts and the routes find the service. The
 * service needs both modes' turn paths, so it is built after them and set
 * here; nothing reads it before the host has started.
 */
export interface ThreadWakeupHolder {
  service: ThreadWakeupService | undefined;
}

export interface ThreadWakeupServiceOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly clock: () => Date;
  readonly uuid: () => string;
  readonly ports: { readonly work: ThreadWakeupModePort; readonly code: ThreadWakeupModePort };
  /** When this host process started: a wake-up due before it was missed. */
  readonly hostStartedAt?: Date;
  /** Injectable so tests drive due times by hand. */
  readonly schedule?: (atEpochMs: number, fire: () => void) => ThreadWakeupTimerHandle;
  readonly unschedule?: (handle: ThreadWakeupTimerHandle) => void;
  /** How long a wake-up whose thread is busy waits before it is offered again. */
  readonly busyRetryMs?: number;
  /**
   * The person's limits from Settings, read at each request and each due
   * time so a change applies at once. Absent is the defaults: 8 waiting a
   * thread, and a missed wake-up waits for the person.
   */
  readonly limits?: () => ThreadWakeupLimits;
  readonly onError?: (message: string, error: unknown) => void;
}

export interface ThreadWakeupLimits {
  readonly waitingPerThread: number;
  /** Run a wake-up that came due while the host was down or asleep once, on return. */
  readonly runMissedOnReturn: boolean;
}

/** `setTimeout` clamps a delay above 2^31-1 ms to one; a later time is armed in chunks. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const BUSY_RETRY_MS = 15_000;
const REPLAY_PAGE = 1_000;

/**
 * The prompt a wake-up's turn starts with: the host's heading, so the agent and
 * the transcript read it as a turn the runtime asked for earlier, then what
 * the agent asked to be told.
 */
function threadWakeupTurnPrompt(prompt: string): string {
  return `${THREAD_WAKEUP_TURN_HEADING}\n\n${prompt}`;
}

interface Held {
  wakeup: ThreadWakeup;
  version: number;
  timer: ThreadWakeupTimerHandle | undefined;
  /** Its turn is being started, or it came due on time and waits for a busy thread. */
  firing: boolean;
}

const waiting = (wakeup: ThreadWakeup) => wakeup.status === "pending" || wakeup.status === "missed";

export class ThreadWakeupService {
  readonly #options: ThreadWakeupServiceOptions;
  readonly #held = new Map<string, Held>();
  readonly #hostStartedAt: Date;

  constructor(options: ThreadWakeupServiceOptions) {
    this.#options = options;
    this.#hostStartedAt = options.hostStartedAt ?? options.clock();
  }

  /**
   * Rebuilds every waiting wake-up from the journal and arms the pending
   * ones. One whose time passed while the host was down is journaled as
   * missed here, before anything could fire it.
   */
  start(): void {
    let afterSequence = 0;
    for (;;) {
      const page = this.#options.journal.replayAggregateType({
        aggregateType: THREAD_WAKEUP_AGGREGATE,
        afterSequence,
        limit: REPLAY_PAGE,
        eventName: THREAD_WAKEUP_CHANGED,
      });
      for (const event of page) {
        afterSequence = event.globalSequence;
        this.#fold(event);
      }
      if (page.length < REPLAY_PAGE) break;
    }
    for (const held of [...this.#held.values()]) {
      if (held.wakeup.status === "pending") this.#arm(held);
    }
  }

  #limits(): ThreadWakeupLimits {
    return (
      this.#options.limits?.() ?? {
        waitingPerThread: DEFAULT_THREAD_WAKEUPS_WAITING,
        runMissedOnReturn: false,
      }
    );
  }

  stop(): void {
    for (const held of this.#held.values()) this.#clearTimer(held);
    this.#held.clear();
  }

  /** The schedule a session of this thread hands its runtime's wake-up requests to. */
  forSession(mode: ThreadWakeupMode, threadId: string): ProviderWakeupSchedule {
    return {
      schedule: async (request) => this.#schedule(mode, threadId, request),
      list: async () => this.list(mode, threadId).map(providerWakeup),
      cancel: async (id) => {
        const held = this.#heldFor(mode, threadId, id);
        if (held === undefined) {
          return { status: "refused", reason: `No wake-up with id '${id}' waits in this thread.` };
        }
        this.#end(held, "cancelled-by-agent", undefined);
        return { status: "cancelled" };
      },
      cancelDelayed: async () => {
        const delayed = this.#waitingIn(mode, threadId).filter(
          (held) => held.wakeup.schedule.kind === "delay",
        );
        for (const held of delayed) this.#end(held, "cancelled-by-agent", undefined);
        return delayed.length;
      },
    };
  }

  /** The thread's pending and missed wake-ups, soonest first. */
  list(mode: ThreadWakeupMode, threadId: string): ReadonlyArray<ThreadWakeup> {
    return this.#waitingIn(mode, threadId)
      .map((held) => held.wakeup)
      .sort((left, right) => Date.parse(left.nextFireAt) - Date.parse(right.nextFireAt));
  }

  read(wakeupId: string): ThreadWakeup | undefined {
    return this.#held.get(wakeupId)?.wakeup;
  }

  /** The person cancels a waiting wake-up of a thread they can open. */
  cancel(wakeupId: string, actor?: EventActor): ThreadWakeupCommandResult {
    const held = this.#held.get(wakeupId);
    if (held === undefined || !waiting(held.wakeup)) {
      return { kind: "thread-wakeup-refused", message: "This wake-up no longer waits." };
    }
    const ended = this.#end(held, "cancelled-by-person", undefined, actor);
    return ended === undefined
      ? { kind: "thread-wakeup-refused", message: "The wake-up could not be cancelled." }
      : { kind: "thread-wakeup-updated", wakeup: ended };
  }

  /** The person runs a missed wake-up now, as its turn would have run. */
  async runMissed(wakeupId: string, actor?: EventActor): Promise<ThreadWakeupCommandResult> {
    const held = this.#held.get(wakeupId);
    if (held === undefined || held.wakeup.status !== "missed" || held.firing) {
      return { kind: "thread-wakeup-refused", message: "Only a missed wake-up can be run now." };
    }
    if (!this.#append(held, { ...held.wakeup }, "run-requested", actor)) {
      return { kind: "thread-wakeup-refused", message: "The wake-up could not be recorded." };
    }
    const outcome = await this.#startTurn(held);
    if (outcome === "busy") {
      return {
        kind: "thread-wakeup-refused",
        message: "A turn is running in this thread; run the wake-up once it ends.",
      };
    }
    return { kind: "thread-wakeup-updated", wakeup: held.wakeup };
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: {
    readonly events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>;
  }): void {
    for (const event of append.events) {
      try {
        this.#watchThread(event);
      } catch (error) {
        this.#options.onError?.("A thread change could not be read for its wake-ups.", error);
      }
    }
  }

  #watchThread(event: { readonly eventName: string; readonly payload: unknown }): void {
    if (event.eventName === "work.thread-updated@1") {
      const { thread } = decodeWorkThreadUpdated(event.payload);
      if (thread.lifecycle !== "active") this.#closeThread("work", String(thread.id));
    } else if (event.eventName === "code.thread-updated@1") {
      const { thread } = decodeCodeThreadUpdated(event.payload);
      if (thread.lifecycle === "archived") this.#closeThread("code", String(thread.id));
    } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      const purged = decodeThreadRetentionThreadPurged(event.payload);
      if (purged.mode === "work" || purged.mode === "code") {
        this.#forgetThread(purged.mode, String(purged.threadId));
      }
    }
  }

  #closeThread(mode: ThreadWakeupMode, threadId: string): void {
    for (const held of this.#waitingIn(mode, threadId)) this.#end(held, "thread-closed", undefined);
  }

  /**
   * A purge already removed the thread's wake-up events from the journal, so
   * its wake-ups are only dropped here: ending one would append a new event
   * naming the purged thread, which a restart would replay.
   */
  #forgetThread(mode: ThreadWakeupMode, threadId: string): void {
    for (const held of this.#waitingIn(mode, threadId)) {
      this.#clearTimer(held);
      this.#held.delete(String(held.wakeup.id));
    }
  }

  async #schedule(
    mode: ThreadWakeupMode,
    threadId: string,
    request: ProviderWakeupRequest,
  ): ReturnType<ProviderWakeupSchedule["schedule"]> {
    const prompt = request.prompt.trim();
    if (prompt.length === 0) return { status: "refused", reason: "A wake-up needs a prompt." };
    if (prompt.length > 4_096) {
      return { status: "refused", reason: "A wake-up's prompt may be at most 4,096 characters." };
    }
    if (!this.#portFor(mode).threadOpen(threadId)) {
      return { status: "refused", reason: "This thread can no longer take wake-ups." };
    }
    const admitted = admitThreadWakeup({
      waitingCount: this.#waitingIn(mode, threadId).length,
      waitingLimit: this.#limits().waitingPerThread,
    });
    if (admitted.status === "refused") return admitted;
    const now = this.#options.clock();
    const planned =
      request.kind === "delay"
        ? planDelayedWakeup({ delaySeconds: request.delaySeconds, now })
        : planCronWakeup({ cron: request.cron, recurring: request.recurring, now });
    if (planned.status === "refused") return planned;
    const schedule =
      request.kind === "delay"
        ? ({ kind: "delay" } as const)
        : ({ kind: "cron", cron: request.cron.trim(), recurring: request.recurring } as const);
    const reason = request.kind === "delay" ? request.reason?.trim().slice(0, 512) : undefined;
    const wakeup: ThreadWakeup = {
      id: decodeThreadWakeupId(this.#options.uuid()),
      mode,
      threadId,
      providerToolName: request.providerToolName.slice(0, 64),
      prompt,
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      schedule,
      humanSchedule: describeThreadWakeup({ schedule, fireAt: planned.fireAt }),
      createdAt: decodeTimestamp(now.toISOString()),
      nextFireAt: decodeTimestamp(planned.fireAt.toISOString()),
      ...(planned.expiresAt === undefined
        ? {}
        : { expiresAt: decodeTimestamp(planned.expiresAt.toISOString()) }),
      status: "pending",
    };
    const held: Held = { wakeup, version: 0, timer: undefined, firing: false };
    if (!this.#append(held, wakeup, "scheduled")) {
      return { status: "refused", reason: "Octant could not record the wake-up." };
    }
    this.#held.set(String(wakeup.id), held);
    this.#arm(held);
    return {
      status: "scheduled",
      wakeup: providerWakeup(held.wakeup),
      ...(planned.clampedDelaySeconds === undefined
        ? {}
        : { clampedDelaySeconds: planned.clampedDelaySeconds }),
      ...(planned.wasClamped === undefined ? {} : { wasClamped: planned.wasClamped }),
    };
  }

  #fold(event: EventEnvelope): void {
    let changed: ThreadWakeupChanged;
    try {
      changed = decodeThreadWakeupChanged(event.payload);
    } catch (error) {
      this.#options.onError?.("A wake-up event did not decode.", error);
      return;
    }
    const key = String(changed.wakeup.id);
    if (key !== String(event.aggregateId)) return;
    if (!waiting(changed.wakeup)) {
      this.#held.delete(key);
      return;
    }
    this.#held.set(key, {
      wakeup: changed.wakeup,
      version: event.aggregateVersion,
      timer: undefined,
      firing: false,
    });
  }

  #arm(held: Held): void {
    this.#clearTimer(held);
    const at = Date.parse(held.wakeup.nextFireAt);
    const now = this.#options.clock().getTime();
    if (at <= now) {
      queueMicrotask(() => void this.#evaluate(String(held.wakeup.id)));
      return;
    }
    const schedule =
      this.#options.schedule ??
      ((when: number, fire: () => void) => setTimeout(fire, Math.max(0, when - Date.now())));
    held.timer = schedule(
      Math.min(at, now + MAX_TIMER_DELAY_MS),
      () => void this.#evaluate(String(held.wakeup.id)),
    );
  }

  #armRetry(held: Held): void {
    this.#clearTimer(held);
    const schedule =
      this.#options.schedule ??
      ((when: number, fire: () => void) => setTimeout(fire, Math.max(0, when - Date.now())));
    held.timer = schedule(
      this.#options.clock().getTime() + (this.#options.busyRetryMs ?? BUSY_RETRY_MS),
      () => void this.#evaluate(String(held.wakeup.id)),
    );
  }

  #clearTimer(held: Held): void {
    if (held.timer === undefined) return;
    const unschedule =
      this.#options.unschedule ??
      ((handle: ThreadWakeupTimerHandle) => clearTimeout(handle as never));
    unschedule(held.timer);
    held.timer = undefined;
  }

  async #evaluate(key: string): Promise<void> {
    const held = this.#held.get(key);
    if (held === undefined || held.wakeup.status !== "pending") return;
    held.timer = undefined;
    if (!held.firing) {
      const due = threadWakeupDue({
        nextFireAt: new Date(held.wakeup.nextFireAt),
        now: this.#options.clock(),
        hostStartedAt: this.#hostStartedAt,
      });
      if (due === "wait") {
        this.#arm(held);
        return;
      }
      // The person may ask in Settings for a missed wake-up to run once on
      // return; a recurring one then carries on from its next match.
      if (due === "missed" && !this.#limits().runMissedOnReturn) {
        this.#append(held, { ...held.wakeup, status: "missed" }, "missed");
        return;
      }
    }
    const outcome = await this.#startTurn(held);
    if (outcome === "busy") this.#armRetry(held);
  }

  /** Starts the wake-up's turn and journals what came of it. */
  async #startTurn(held: Held): Promise<"started" | "busy" | "ended"> {
    const port = this.#portFor(held.wakeup.mode);
    if (!port.threadOpen(held.wakeup.threadId)) {
      this.#end(held, "thread-closed", undefined);
      return "ended";
    }
    // A busy thread's retries, or a missed one the person runs, can come
    // round after a recurring wake-up's lifetime; it ends there, before a
    // turn is admitted, never after one started.
    if (
      held.wakeup.expiresAt !== undefined &&
      this.#options.clock().getTime() > Date.parse(held.wakeup.expiresAt)
    ) {
      this.#end(held, "expired", undefined);
      return "ended";
    }
    held.firing = true;
    let result: Awaited<ReturnType<ThreadWakeupModePort["startTurn"]>>;
    try {
      result = await port.startTurn(
        held.wakeup.threadId,
        threadWakeupTurnPrompt(held.wakeup.prompt),
      );
    } catch (error) {
      result = {
        status: "refused",
        message: error instanceof Error ? error.message : "The turn could not be started.",
      };
    }
    if (!waiting(held.wakeup) || this.#held.get(String(held.wakeup.id)) !== held) {
      // Cancelled or closed while the turn was being started.
      return "ended";
    }
    if (result.status === "busy") {
      // A missed wake-up the person ran stays missed; a pending one keeps
      // its on-time standing and is offered again after the thread's turn.
      if (held.wakeup.status === "missed") held.firing = false;
      return "busy";
    }
    held.firing = false;
    if (result.status === "refused") {
      this.#end(held, "refused", result.message);
      return "ended";
    }
    const now = this.#options.clock();
    const fired = {
      lastFiredAt: decodeTimestamp(now.toISOString()),
      lastTurnId: result.turnId.slice(0, 255),
    };
    const next =
      held.wakeup.schedule.kind === "cron"
        ? nextThreadWakeupFire({
            cron: held.wakeup.schedule.cron,
            recurring: held.wakeup.schedule.recurring,
            expiresAt:
              held.wakeup.expiresAt === undefined ? undefined : new Date(held.wakeup.expiresAt),
            now,
          })
        : undefined;
    if (next !== undefined) {
      const { detail: _detail, ...rest } = held.wakeup;
      this.#append(
        held,
        { ...rest, ...fired, status: "pending", nextFireAt: decodeTimestamp(next.toISOString()) },
        "fired",
      );
      this.#arm(held);
      return "started";
    }
    const recurring = held.wakeup.schedule.kind === "cron" && held.wakeup.schedule.recurring;
    this.#end(held, recurring ? "expired" : "fired", undefined, undefined, fired);
    return "started";
  }

  #end(
    held: Held,
    reason: ThreadWakeupEndedReason,
    detail: string | undefined,
    actor?: EventActor,
    fired?: { readonly lastFiredAt: ThreadWakeup["lastFiredAt"]; readonly lastTurnId: string },
  ): ThreadWakeup | undefined {
    this.#clearTimer(held);
    const trimmed = detail?.trim().slice(0, 512);
    const { detail: _previous, ...rest } = held.wakeup;
    const ended: ThreadWakeup = {
      ...rest,
      ...fired,
      status: "ended",
      endedReason: reason,
      ...(trimmed === undefined || trimmed.length === 0 ? {} : { detail: trimmed }),
    };
    if (!this.#append(held, ended, reason === "fired" ? "fired" : "ended", actor)) return undefined;
    this.#held.delete(String(held.wakeup.id));
    return ended;
  }

  /** Journals the wake-up's new state; the in-memory copy changes only once it is committed. */
  #append(
    held: Held,
    next: ThreadWakeup,
    change: ThreadWakeupChanged["change"],
    actor?: EventActor,
  ): boolean {
    try {
      this.#options.journal.append({
        aggregate: { aggregateType: THREAD_WAKEUP_AGGREGATE, aggregateId: String(next.id) },
        expectedVersion: held.version,
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: THREAD_WAKEUP_CHANGED,
            eventVersion: 1,
            hostId: LOCAL_HOST_ID,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: actor ?? { kind: "system", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
            occurredAt: decodeTimestamp(this.#options.clock().toISOString()),
            payload: { wakeup: next, change },
          },
        ],
      });
    } catch (error) {
      this.#options.onError?.("A wake-up change could not be journaled.", error);
      return false;
    }
    held.version += 1;
    held.wakeup = next;
    return true;
  }

  #waitingIn(mode: ThreadWakeupMode, threadId: string): Held[] {
    return [...this.#held.values()].filter(
      (held) =>
        held.wakeup.mode === mode && held.wakeup.threadId === threadId && waiting(held.wakeup),
    );
  }

  #heldFor(mode: ThreadWakeupMode, threadId: string, id: string): Held | undefined {
    const held = this.#held.get(id);
    return held !== undefined &&
      held.wakeup.mode === mode &&
      held.wakeup.threadId === threadId &&
      waiting(held.wakeup)
      ? held
      : undefined;
  }

  #portFor(mode: ThreadWakeupMode): ThreadWakeupModePort {
    return mode === "work" ? this.#options.ports.work : this.#options.ports.code;
  }
}

function providerWakeup(wakeup: ThreadWakeup): ProviderWakeup {
  return {
    id: String(wakeup.id),
    schedule: wakeup.schedule,
    prompt: wakeup.prompt,
    humanSchedule: wakeup.humanSchedule,
    nextFireAt: wakeup.nextFireAt,
    status: wakeup.status === "missed" ? "missed" : "pending",
  };
}
