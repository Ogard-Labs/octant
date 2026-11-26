/**
 * The person's two usage-limit defaults: "Resume at reset by default" and
 * "Snooze until reset by default". When a provider's own usage-limit signal
 * stops a turn and the stop is journaled, the host arms the resume or the
 * snooze for that stop exactly as the person's own button would, through the
 * mode's ordinary command, with the resume record marked `origin: "default"`.
 * The resume itself still fires through the usage-resume scheduler and the
 * mode's ordinary turn admission.
 *
 * A default applies only to a stop that:
 * - names a reset that is still ahead (a billing stop never does);
 * - belongs to a turn a person sent from a window on this computer or a
 *   device they paired, in this host process (`PersonSentTurns`); for Chat,
 *   whose retries reuse the turn, to the attempt the person started, so a
 *   default resume that stops again never arms another; a turn a routine, a
 *   wake-up, an agent, a delivery or a queued message started is never
 *   covered, and neither is one whose sender the host no longer knows after a
 *   restart;
 * - is on a provider account that does not refuse the host's continuations
 *   (the resume only; a snooze starts nothing);
 * - is not the thread's account handoff's to act on
 *   (`stopLeftToUsageLimitHandoff`): a default written while the handoff's
 *   provider change waits on validation would win the version race and keep
 *   the thread on the limited account.
 *
 * Each stopped turn (Chat: attempt) is armed at most once, whatever reset it
 * is journaled with later, so a default the person cancels stays cancelled.
 */
import {
  decodeChatAttemptUpdated,
  decodeCodeOperationEventFrame,
  decodeWorkTurnUpdated,
  type CommittedAppend,
  type EventEnvelope,
  type ProviderUsageLimit,
} from "@octant/contracts";

export type UsageLimitDefaultsMode = "chat" | "work" | "code";

/**
 * The stop a default would arm against: the thread, the stopped turn (Chat:
 * turn and attempt; Code: the provider-turn operation) and the limit fact.
 */
export interface UsageLimitStop {
  readonly mode: UsageLimitDefaultsMode;
  readonly threadId: string;
  readonly turnId: string;
  readonly attemptId?: string;
  readonly usageLimit: ProviderUsageLimit;
}

/**
 * Turns a person sent, as the routes that took them saw the sender. Kept in
 * memory and bounded: a default is a convenience, so an entry lost to a
 * restart or the bound only means no default arms for that stop.
 */
export class PersonSentTurns {
  readonly #limit: number;
  readonly #turns = new Set<string>();

  constructor(limit = 2_048) {
    this.#limit = limit;
  }

  note(mode: UsageLimitDefaultsMode, turnId: string): void {
    const key = `${mode}:${turnId}`;
    this.#turns.delete(key);
    this.#turns.add(key);
    if (this.#turns.size <= this.#limit) return;
    const oldest = this.#turns.values().next();
    if (oldest.done !== true) this.#turns.delete(oldest.value);
  }

  sent(mode: UsageLimitDefaultsMode, turnId: string): boolean {
    return this.#turns.has(`${mode}:${turnId}`);
  }
}

export interface UsageLimitDefaultsOptions {
  readonly settings: () => {
    readonly resumeAtReset: boolean;
    readonly snoozeUntilReset: boolean;
  };
  /** Whether a person started the stopped turn; see `personSentKey`. */
  readonly personSent: (mode: UsageLimitDefaultsMode, key: string) => boolean;
  /** The provider account the thread runs on now, if the thread is still there. */
  readonly providerInstanceOf: (
    mode: UsageLimitDefaultsMode,
    threadId: string,
  ) => string | undefined;
  /** Whether the account's sign-in refuses turns the host starts by itself. */
  readonly refusesHostContinuations: (providerInstanceId: string) => boolean;
  /** Whether the thread's usage-limit account handoff owns this stop. */
  readonly leftToAccountHandoff: (stop: UsageLimitStop) => boolean;
  readonly clock: () => Date;
  /** The mode's ordinary commands, run as the host. Each throws when the mode refuses. */
  readonly scheduleResume: (stop: UsageLimitStop) => Promise<void>;
  readonly snoozeAtReset: (stop: UsageLimitStop) => Promise<void>;
  /**
   * Whether a refusal only says the thread moved on between the stop and the
   * command (a stale version). Such a command is tried once more.
   */
  readonly isStale?: (error: unknown) => boolean;
  /** Queues the arming after the committing append returns. */
  readonly defer?: (run: () => void) => void;
  readonly onError?: (message: string, error: unknown) => void;
}

/** The usage-limit stop an event journals, if it journals one. */
export function usageLimitStopOf(event: EventEnvelope): UsageLimitStop | undefined {
  switch (event.eventName) {
    case "chat.attempt-updated@1": {
      const { attempt } = decodeChatAttemptUpdated(event.payload);
      if (attempt.outcome !== "waiting" || attempt.usageLimit === undefined) return undefined;
      return {
        mode: "chat",
        threadId: String(attempt.threadId),
        turnId: String(attempt.turnId),
        attemptId: String(attempt.id),
        usageLimit: attempt.usageLimit,
      };
    }
    case "work.turn-updated@1": {
      const updated = decodeWorkTurnUpdated(event.payload);
      if (updated.status !== "waiting" || updated.failure?.usageLimit === undefined) {
        return undefined;
      }
      return {
        mode: "work",
        threadId: String(updated.threadId),
        turnId: String(updated.turnId),
        usageLimit: updated.failure.usageLimit,
      };
    }
    case "code.operation-event-recorded@1": {
      const frame = decodeCodeOperationEventFrame(event.payload);
      if (
        frame.event.kind !== "operation-result" ||
        frame.event.result.kind !== "provider-turn-state" ||
        frame.event.result.state !== "waiting" ||
        frame.event.result.failure?.usageLimit === undefined
      ) {
        return undefined;
      }
      return {
        mode: "code",
        threadId: String(frame.threadId),
        turnId: String(frame.operationId),
        usageLimit: frame.event.result.failure.usageLimit,
      };
    }
    default:
      return undefined;
  }
}

/**
 * What `PersonSentTurns` records for a stop: the turn, and for Chat the
 * attempt too, since a Chat retry continues the same turn.
 */
export const personSentKey = (stop: UsageLimitStop): string =>
  stop.attemptId === undefined ? stop.turnId : `${stop.turnId}:${stop.attemptId}`;

// The reset is left out on purpose: the same stopped turn journaled again with
// another reset must not arm a default the person already cancelled.
const stopKey = (stop: UsageLimitStop) =>
  `${stop.mode}:${stop.threadId}:${stop.turnId}:${stop.attemptId ?? ""}`;

/** How many armed stops are remembered so a replayed or repeated stop never re-arms. */
const REMEMBERED_STOPS = 2_048;

export class UsageLimitDefaults {
  readonly #options: UsageLimitDefaultsOptions;
  readonly #armed = new Set<string>();

  constructor(options: UsageLimitDefaultsOptions) {
    this.#options = options;
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      let stop: UsageLimitStop | undefined;
      try {
        stop = usageLimitStopOf(event);
      } catch (error) {
        this.#options.onError?.("A usage-limit stop did not decode.", error);
        continue;
      }
      if (stop === undefined) continue;
      const found = stop;
      const defer = this.#options.defer ?? ((run: () => void) => void queueMicrotask(run));
      defer(() => void this.arm(found));
    }
  }

  /**
   * Arms what the person's defaults ask for on this stop, when it qualifies.
   * Answers what it armed, for the record and for tests.
   */
  async arm(
    stop: UsageLimitStop,
  ): Promise<{ readonly resumed: boolean; readonly snoozed: boolean }> {
    const none = { resumed: false, snoozed: false };
    const settings = this.#options.settings();
    if (!settings.resumeAtReset && !settings.snoozeUntilReset) return none;
    const key = stopKey(stop);
    if (this.#armed.has(key)) return none;
    if (!this.#qualifies(stop)) return none;
    this.#remember(key);
    let resumed = false;
    let snoozed = false;
    if (settings.resumeAtReset && this.#mayResume(stop)) {
      resumed = await this.#run(
        () => this.#options.scheduleResume(stop),
        "The default resume at reset was refused.",
      );
    }
    if (settings.snoozeUntilReset) {
      snoozed = await this.#run(
        () => this.#options.snoozeAtReset(stop),
        "The default snooze until reset was refused.",
      );
    }
    return { resumed, snoozed };
  }

  /**
   * Runs one mode command, once more if the first lost a version race with
   * another write to the thread (the stop's own projection update, a title):
   * the stop is remembered before the command, so a lost race would
   * otherwise drop the default for good.
   */
  async #run(command: () => Promise<void>, refusal: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await command();
        return true;
      } catch (error) {
        if (attempt === 0 && this.#options.isStale?.(error) === true) continue;
        this.#options.onError?.(refusal, error);
        return false;
      }
    }
    return false;
  }

  #qualifies(stop: UsageLimitStop): boolean {
    const limit = stop.usageLimit;
    if (limit.kind === "billing" || limit.resetsAt === undefined) return false;
    if (Date.parse(limit.resetsAt) <= this.#options.clock().getTime()) return false;
    if (!this.#options.personSent(stop.mode, personSentKey(stop))) return false;
    return !this.#options.leftToAccountHandoff(stop);
  }

  #mayResume(stop: UsageLimitStop): boolean {
    const providerInstanceId = this.#options.providerInstanceOf(stop.mode, stop.threadId);
    return (
      providerInstanceId !== undefined &&
      !this.#options.refusesHostContinuations(providerInstanceId)
    );
  }

  #remember(key: string): void {
    this.#armed.add(key);
    if (this.#armed.size <= REMEMBERED_STOPS) return;
    const oldest = this.#armed.values().next();
    if (oldest.done !== true) this.#armed.delete(oldest.value);
  }
}
