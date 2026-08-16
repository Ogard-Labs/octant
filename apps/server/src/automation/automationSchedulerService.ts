import {
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationId,
  type AutomationOccurrenceKeyText,
  type AutomationRun,
  type AutomationRunId,
  type AutomationScheduledOccurrence,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  AUTOMATION_DEFAULT_RECONCILIATION_CAP,
  buildAutomationWeeklyResolution,
  buildScheduledAutomationOccurrenceKey,
  canExhaustOnceAutomation,
  isAutomationRunLifecycleActive,
  reconcileMissedAutomationOccurrences,
} from "@octant/domain";
import { Duration, Effect, Fiber } from "effect";
import type { AutomationDispatchPort } from "./automationDispatchPort";
import {
  AutomationEventStoreError,
  type AutomationEventStore,
  type AutomationOccurrenceLedgerEvent,
} from "./automationEventStore";
import { hydrateAutomationProjection, type AutomationProjection } from "./automationProjection";
import {
  automationRunIdForOccurrence,
  buildAutomationRunForOccurrence,
} from "./automationRunIdentity";

export interface AutomationSchedulerConfig {
  /**
   * How late an occurrence may be and still dispatch as "on time". Anything
   * older is a missed occurrence and follows the definition's missed-run
   * policy, so a laptop sleep or long process pause never turns into a burst.
   */
  readonly dueGraceMs: number;
  /**
   * How long a pre-thread `dispatching` transition owns its run before
   * startup/reconciliation moves it to journaled `recovering-dispatch`.
   */
  readonly leaseDurationMs: number;
  /** Safety cap on missed occurrences examined per reconciliation pass. */
  readonly missedRunCap: number;
  /** Upper bound between passes; also the wall-clock-change detection bound. */
  readonly pollIntervalMs: number;
}

export const AUTOMATION_SCHEDULER_DEFAULTS: AutomationSchedulerConfig = {
  dueGraceMs: 60_000,
  leaseDurationMs: 300_000,
  missedRunCap: AUTOMATION_DEFAULT_RECONCILIATION_CAP,
  pollIntervalMs: 60_000,
};

export class AutomationSchedulerError extends Error {
  override readonly name = "AutomationSchedulerError";
  readonly category: "hydration-failed" | "journal-mismatch";

  constructor(category: AutomationSchedulerError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface AutomationSchedulerPassError {
  readonly automationId: AutomationId;
  readonly message: string;
}

export interface AutomationSchedulerPassSummary {
  readonly claimedRunIds: ReadonlyArray<AutomationRunId>;
  readonly skippedOccurrenceKeys: ReadonlyArray<AutomationOccurrenceKeyText>;
  readonly blockedAutomationIds: ReadonlyArray<AutomationId>;
  readonly exhaustedAutomationIds: ReadonlyArray<AutomationId>;
  /** Pre-thread runs whose expired dispatch lease moved to recovering-dispatch. */
  readonly recoveredRunIds: ReadonlyArray<AutomationRunId>;
  /** Existing runs whose crashed occurrence-claim ledger was completed. */
  readonly repairedRunIds: ReadonlyArray<AutomationRunId>;
  /** Definitions whose newest due occurrence waits for the active slot. */
  readonly deferredAutomationIds: ReadonlyArray<AutomationId>;
  readonly errors: ReadonlyArray<AutomationSchedulerPassError>;
  readonly nextWakeAt: UtcTimestamp | undefined;
}

export interface AutomationSchedulerServiceOptions {
  readonly store: Pick<
    AutomationEventStore,
    "appendOccurrenceLedger" | "appendRunCreated" | "appendRunStatusChanged" | "replayAll"
  >;
  readonly projection: AutomationProjection;
  readonly dispatch: AutomationDispatchPort;
  /** Wall clock: selects due occurrences and bounds persisted leases. */
  readonly now: () => UtcTimestamp;
  readonly config?: Partial<AutomationSchedulerConfig>;
}

interface PassCollector {
  readonly now: UtcTimestamp;
  readonly nowMs: number;
  readonly claimedRunIds: Array<AutomationRunId>;
  readonly skippedOccurrenceKeys: Array<AutomationOccurrenceKeyText>;
  readonly blockedAutomationIds: Array<AutomationId>;
  readonly exhaustedAutomationIds: Array<AutomationId>;
  readonly recoveredRunIds: Array<AutomationRunId>;
  readonly repairedRunIds: Array<AutomationRunId>;
  readonly deferredAutomationIds: Array<AutomationId>;
  readonly errors: Array<AutomationSchedulerPassError>;
  wakeMs: number | undefined;
}

/**
 * The one host-local durable Automation scheduler (design §6–7). An
 * Effect-owned timer loop reconciles due and missed occurrences against the
 * authoritative journal: every claim commits the deterministic run aggregate
 * first and the definition-side occurrence ledger second, so a crash between
 * the two repairs forward to the same run instead of dispatching twice, and
 * optimistic concurrency resolves simultaneous claim attempts to one winner.
 * Thread creation stays behind the dispatch port (A4); this service only
 * journals ownership and re-offers queued or recovering runs.
 *
 * Clock rules: the injected wall clock selects due occurrences and bounds
 * persisted leases; Effect's clock owns in-process timers, so tests drive the
 * loop with TestClock and no renderer or browser timer ever gains authority.
 */
export class AutomationSchedulerService {
  readonly #store: AutomationSchedulerServiceOptions["store"];
  readonly #projection: AutomationProjection;
  readonly #dispatch: AutomationDispatchPort;
  readonly #now: () => UtcTimestamp;
  readonly #config: AutomationSchedulerConfig;
  readonly #offered = new Set<string>();
  #notify: (() => void) | undefined;
  #pokedWhileWorking = false;
  #fiber: Fiber.RuntimeFiber<never, never> | undefined;

  constructor(options: AutomationSchedulerServiceOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#dispatch = options.dispatch;
    this.#now = options.now;
    this.#config = { ...AUTOMATION_SCHEDULER_DEFAULTS, ...options.config };
  }

  /**
   * One idempotent reconciliation pass over every definition. Failures are
   * isolated per Automation: a poisoned definition reports a typed error in
   * the summary and never blocks its siblings or the timer loop.
   */
  runPass(): AutomationSchedulerPassSummary {
    const now = this.#now();
    const out: PassCollector = {
      now,
      nowMs: parseUtc(now),
      claimedRunIds: [],
      skippedOccurrenceKeys: [],
      blockedAutomationIds: [],
      exhaustedAutomationIds: [],
      recoveredRunIds: [],
      repairedRunIds: [],
      deferredAutomationIds: [],
      errors: [],
      wakeMs: undefined,
    };
    for (const definition of this.#projection.listDefinitions()) {
      try {
        this.#passOne(definition.id, out);
      } catch (error) {
        out.errors.push({
          automationId: definition.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      claimedRunIds: out.claimedRunIds,
      skippedOccurrenceKeys: out.skippedOccurrenceKeys,
      blockedAutomationIds: out.blockedAutomationIds,
      exhaustedAutomationIds: out.exhaustedAutomationIds,
      recoveredRunIds: out.recoveredRunIds,
      repairedRunIds: out.repairedRunIds,
      deferredAutomationIds: out.deferredAutomationIds,
      errors: out.errors,
      nextWakeAt: out.wakeMs === undefined ? undefined : toUtc(out.wakeMs),
    };
  }

  /**
   * The Effect-owned scheduler loop: run one pass, then sleep until the next
   * due instant, lease expiry, or poll bound — whichever comes first — or
   * until a poke. Interruption is the shutdown path and is always safe: a
   * pass is one synchronous section, so no partial claim can be interrupted.
   */
  loop(): Effect.Effect<never> {
    const tick: Effect.Effect<void> = Effect.suspend(() => {
      let summary: AutomationSchedulerPassSummary | undefined;
      try {
        summary = this.runPass();
      } catch {
        // A pass-level defect (for example failed hydration) must not kill
        // the timer fiber; the next tick retries against the journal.
        summary = undefined;
      }
      return this.#awaitWake(this.#delayMsFor(summary));
    });
    return Effect.forever(tick);
  }

  /** Fork the loop on the host runtime. Idempotent. */
  start(): void {
    if (this.#fiber !== undefined) return;
    this.#fiber = Effect.runFork(this.loop());
  }

  /** Interrupt the loop and wait for the fiber to settle. Idempotent. */
  async stop(): Promise<void> {
    const fiber = this.#fiber;
    if (fiber === undefined) return;
    this.#fiber = undefined;
    await Effect.runPromise(Fiber.interrupt(fiber));
  }

  /**
   * Wake the loop immediately, for example after an Automation command
   * committed. Never lost: a poke during a running pass marks the next wait
   * as already elapsed.
   */
  poke(): void {
    const notify = this.#notify;
    this.#notify = undefined;
    if (notify !== undefined) {
      notify();
    } else {
      this.#pokedWhileWorking = true;
    }
  }

  #passOne(automationId: AutomationId, out: PassCollector): void {
    let definition = this.#definition(automationId);
    if (definition === undefined) return;

    // 1. Complete a half-committed claim: the run aggregate committed but the
    //    crash landed before the occurrence ledger. The deterministic run id
    //    makes this the same claim, never a second dispatch.
    const latest = this.#projection.latestRun(definition.id);
    if (
      latest !== undefined &&
      latest.occurrence.kind === "scheduled" &&
      !this.#projection.isOccurrenceConsumed(definition.id, latest.occurrenceKey)
    ) {
      this.#repairClaim(definition, latest, out);
      definition = this.#definition(automationId);
      if (definition === undefined) return;
    }

    // 2. Interrupted-lease recovery and dispatch re-offers for the active run.
    const active = this.#projection.activeRun(definition.id);
    if (active !== undefined) this.#recoverAndOffer(definition, active, out);

    // 3. A consumed once occurrence exhausts its definition after the run is
    //    terminal; a committed receipt is never recreated.
    definition = this.#definition(automationId);
    if (definition === undefined) return;
    this.#exhaustConsumedOnce(definition, out);
    definition = this.#definition(automationId);
    if (definition === undefined) return;

    // 4. Due/missed reconciliation only schedules enabled definitions.
    if (definition.lifecycle !== "enabled" || definition.nextDueAt === null) return;
    this.#reconcileDue(definition, out);
  }

  #repairClaim(definition: AutomationDefinition, run: AutomationRun, out: PassCollector): void {
    const events: Array<AutomationOccurrenceLedgerEvent> = [];
    if (
      run.scheduledAt !== null &&
      run.occurrence.kind === "scheduled" &&
      run.occurrence.definitionRevision === definition.definitionRevision &&
      definition.nextDueAt !== null &&
      parseUtc(definition.nextDueAt) <= parseUtc(run.scheduledAt)
    ) {
      // Recompute the skipped receipts the crashed pass would have journaled:
      // unconsumed occurrences strictly before the claimed instant.
      for (const scheduledAt of this.#dueInstantsThrough(definition, run.scheduledAt)) {
        if (parseUtc(scheduledAt) >= parseUtc(run.scheduledAt)) break;
        if (this.#isConsumed(definition, scheduledAt)) continue;
        events.push({
          kind: "occurrence-skipped",
          occurrence: this.#scheduledOccurrence(definition, scheduledAt),
          reason: "missed-run-policy",
          at: out.now,
        });
      }
    }
    events.push({
      kind: "occurrence-claimed",
      occurrence: run.occurrence,
      runId: run.id,
      at: out.now,
    });
    this.#appendLedger(definition.id, events);
    out.repairedRunIds.push(run.id);
  }

  #recoverAndOffer(definition: AutomationDefinition, run: AutomationRun, out: PassCollector): void {
    if (run.lifecycle === "dispatching" && run.dispatchIntent === undefined) {
      // A pre-thread dispatch lease is bounded by the persisted transition
      // instant, so it survives restart. A run with a committed thread
      // receipt stays `dispatching`; launch claims serialize its recovery.
      const leaseExpiresMs = parseUtc(run.updatedAt) + this.#config.leaseDurationMs;
      if (out.nowMs >= leaseExpiresMs) {
        try {
          this.#store.appendRunStatusChanged({
            automationId: definition.id,
            runId: run.id,
            previousLifecycle: run.lifecycle,
            lifecycle: "recovering-dispatch",
            version: run.version + 1,
            expectedVersion: run.version,
            updatedAt: out.now,
          });
          out.recoveredRunIds.push(run.id);
        } catch (error) {
          if (!isConflict(error)) throw error;
          this.#rehydrate();
        }
      } else {
        this.#addWake(out, leaseExpiresMs);
      }
    }
    const current = this.#projection.getRun(run.id) ?? run;
    if (current.cancellationTombstone !== undefined) return;
    if (current.lifecycle === "queued" || current.lifecycle === "recovering-dispatch") {
      this.#offer(definition, current);
      return;
    }
    // Post-thread launch recovery: an unexpired claim is observed; an absent
    // or expired claim is re-offered so A4 can acquire the next generation.
    if (
      current.lifecycle === "dispatching" &&
      current.dispatchIntent !== undefined &&
      current.firstTurnAcceptance === undefined
    ) {
      const claim = current.runtimeLaunchClaim;
      if (claim !== undefined && out.nowMs < parseUtc(claim.leaseExpiresAt)) {
        this.#addWake(out, parseUtc(claim.leaseExpiresAt));
        return;
      }
      this.#offer(definition, current);
    }
  }

  #exhaustConsumedOnce(definition: AutomationDefinition, out: PassCollector): void {
    if (definition.trigger.kind !== "once" || definition.lifecycle !== "enabled") return;
    const scheduledAt = definition.trigger.scheduledAt;
    if (!this.#isConsumed(definition, scheduledAt)) return;
    const run = this.#projection.getRun(
      automationRunIdForOccurrence(this.#occurrenceKey(definition, scheduledAt)),
    );
    if (run === undefined || run.scheduledAt === null) return;
    if (
      !canExhaustOnceAutomation({
        trigger: definition.trigger,
        currentDefinitionRevision: definition.definitionRevision,
        occurrenceDefinitionRevision: run.occurrence.definitionRevision,
        currentOnceAt: scheduledAt,
        occurrenceScheduledAt: run.scheduledAt,
        terminal: !isAutomationRunLifecycleActive(run.lifecycle),
      })
    ) {
      return;
    }
    this.#appendLedger(definition.id, [
      {
        kind: "exhausted",
        definitionRevision: definition.definitionRevision,
        consumedScheduledAt: scheduledAt,
        at: out.now,
      },
    ]);
    out.exhaustedAutomationIds.push(definition.id);
  }

  #reconcileDue(definition: AutomationDefinition, out: PassCollector): void {
    if (definition.nextDueAt === null) return;
    if (
      definition.trigger.kind === "once" &&
      this.#isConsumed(definition, definition.trigger.scheduledAt)
    ) {
      // Claimed but not yet terminal: exhaustion clears the ledger later.
      return;
    }
    if (parseUtc(definition.nextDueAt) > out.nowMs) {
      this.#addWake(out, parseUtc(definition.nextDueAt));
      return;
    }

    const result = reconcileMissedAutomationOccurrences({
      trigger: definition.trigger,
      nextDueAt: definition.nextDueAt,
      now: out.now,
      policy: definition.missedRunPolicy,
      cap: this.#config.missedRunCap,
    });
    if (result.kind === "cap-exceeded") {
      this.#appendLedger(definition.id, [
        {
          kind: "blocked",
          reason: "missed-run-cap-exceeded",
          examinedFrom: result.examinedFrom,
          examinedThrough: result.examinedThrough,
          ...(result.nextDueAt === null ? {} : { nextFutureOccurrence: result.nextDueAt }),
          at: out.now,
        },
      ]);
      out.blockedAutomationIds.push(definition.id);
      return;
    }

    const dues = [
      ...result.skipped,
      ...(result.claimed === undefined ? [] : [result.claimed]),
    ].filter((instant) => !this.#isConsumed(definition, instant));
    if (dues.length === 0) {
      if (result.nextDueAt !== null) this.#addWake(out, parseUtc(result.nextDueAt));
      return;
    }
    const newest = dues[dues.length - 1] as UtcTimestamp;

    const active = this.#projection.activeRun(definition.id);
    if (active !== undefined) {
      // One active occurrence per Automation: a newly due occurrence follows
      // the missed-run policy and never silently overlaps (design §7.3).
      if (definition.missedRunPolicy === "skip") {
        this.#skipAll(definition, dues, out);
      } else {
        if (dues.length > 1) this.#skipAll(definition, dues.slice(0, -1), out, false);
        out.deferredAutomationIds.push(definition.id);
      }
      return;
    }

    const newestIsOnTime = out.nowMs - parseUtc(newest) <= this.#config.dueGraceMs;
    if (definition.missedRunPolicy === "skip" && !newestIsOnTime) {
      this.#skipAll(definition, dues, out);
      if (result.nextDueAt !== null) this.#addWake(out, parseUtc(result.nextDueAt));
      return;
    }

    this.#claim(definition, dues, out);
  }

  /**
   * Journal skipped receipts for every given occurrence; a once trigger with
   * no future occurrence exhausts atomically in the same batch.
   */
  #skipAll(
    definition: AutomationDefinition,
    instants: ReadonlyArray<UtcTimestamp>,
    out: PassCollector,
    exhaustOnce = true,
  ): void {
    const events: Array<AutomationOccurrenceLedgerEvent> = instants.map((scheduledAt) => ({
      kind: "occurrence-skipped",
      occurrence: this.#scheduledOccurrence(definition, scheduledAt),
      reason: "missed-run-policy",
      at: out.now,
    }));
    if (exhaustOnce && definition.trigger.kind === "once") {
      events.push({
        kind: "exhausted",
        definitionRevision: definition.definitionRevision,
        consumedScheduledAt: definition.trigger.scheduledAt,
        at: out.now,
      });
      out.exhaustedAutomationIds.push(definition.id);
    }
    this.#appendLedger(definition.id, events);
    for (const scheduledAt of instants) {
      out.skippedOccurrenceKeys.push(this.#occurrenceKey(definition, scheduledAt));
    }
  }

  /**
   * Claim the newest due occurrence: commit the deterministic run aggregate
   * first, then the occurrence ledger (older receipts skipped plus the claim)
   * in one atomic definition-side batch. A run-create conflict means another
   * writer owns the same claim; the journal decides the single winner.
   */
  #claim(
    definition: AutomationDefinition,
    dues: ReadonlyArray<UtcTimestamp>,
    out: PassCollector,
  ): void {
    const newest = dues[dues.length - 1] as UtcTimestamp;
    const occurrence = this.#scheduledOccurrence(definition, newest);
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
    const runId = automationRunIdForOccurrence(occurrenceKey);

    let run = this.#projection.getRun(runId);
    if (run === undefined) {
      const candidate = buildAutomationRunForOccurrence({
        definition,
        occurrence,
        now: out.now,
      });
      try {
        this.#store.appendRunCreated({ run: candidate });
        run = candidate;
      } catch (error) {
        if (!isConflict(error)) throw error;
        this.#rehydrate();
        if (this.#projection.isOccurrenceConsumed(definition.id, occurrenceKey)) {
          // A rival scheduler committed the full claim; nothing to do.
          return;
        }
        run = this.#projection.getRun(runId);
        if (run === undefined) {
          throw new AutomationSchedulerError(
            "journal-mismatch",
            "Automation claim conflicted but the committed run is not replayable.",
          );
        }
      }
    }

    const skipped = dues.slice(0, -1);
    const events: Array<AutomationOccurrenceLedgerEvent> = [
      ...skipped.map(
        (scheduledAt): AutomationOccurrenceLedgerEvent => ({
          kind: "occurrence-skipped",
          occurrence: this.#scheduledOccurrence(definition, scheduledAt),
          reason: "missed-run-policy",
          at: out.now,
        }),
      ),
      { kind: "occurrence-claimed", occurrence, runId: run.id, at: out.now },
    ];
    this.#appendLedger(definition.id, events);
    for (const scheduledAt of skipped) {
      out.skippedOccurrenceKeys.push(this.#occurrenceKey(definition, scheduledAt));
    }
    out.claimedRunIds.push(run.id);
    const refreshed = this.#definition(definition.id);
    this.#offer(refreshed ?? definition, this.#projection.getRun(run.id) ?? run);
  }

  /**
   * Append one atomic occurrence-ledger batch against the projected head. On
   * a concurrency conflict the projection rehydrates from the journal and the
   * batch retries once with already-consumed frames dropped, so a lost race
   * converges instead of double-journaling.
   */
  #appendLedger(
    automationId: AutomationId,
    events: ReadonlyArray<AutomationOccurrenceLedgerEvent>,
  ): void {
    if (events.length === 0) return;
    const current = this.#definition(automationId);
    if (current === undefined) {
      throw new AutomationSchedulerError(
        "journal-mismatch",
        "Automation definition disappeared from the projection during a pass.",
      );
    }
    try {
      this.#store.appendOccurrenceLedger({
        automationId,
        expectedVersion: current.version,
        events,
      });
      return;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    this.#rehydrate();
    const refreshed = this.#definition(automationId);
    if (refreshed === undefined) return;
    const remaining = events.filter((event) => {
      switch (event.kind) {
        case "occurrence-skipped":
        case "occurrence-claimed":
          return !this.#projection.isOccurrenceConsumed(
            automationId,
            deriveAutomationOccurrenceKey(event.occurrence),
          );
        case "blocked":
          return refreshed.blockedReason === undefined;
        case "exhausted":
          return refreshed.lifecycle !== "exhausted";
      }
    });
    if (remaining.length === 0) return;
    this.#store.appendOccurrenceLedger({
      automationId,
      expectedVersion: refreshed.version,
      events: remaining,
    });
  }

  #offer(definition: AutomationDefinition, run: AutomationRun): void {
    const key = `${String(run.id)}:${run.lifecycle}:${run.version}`;
    if (this.#offered.has(key)) return;
    this.#offered.add(key);
    try {
      this.#dispatch.offer({ definition, run });
    } catch {
      // The claim is durable; a lost notification re-offers after restart.
      this.#offered.delete(key);
    }
  }

  /** Every scheduled occurrence from the due ledger through `through`. */
  #dueInstantsThrough(
    definition: AutomationDefinition,
    through: UtcTimestamp,
  ): ReadonlyArray<UtcTimestamp> {
    if (definition.nextDueAt === null) return [];
    const result = reconcileMissedAutomationOccurrences({
      trigger: definition.trigger,
      nextDueAt: definition.nextDueAt,
      now: through,
      policy: "skip",
      cap: this.#config.missedRunCap,
    });
    return result.kind === "reconciled" ? result.skipped : [];
  }

  #scheduledOccurrence(
    definition: AutomationDefinition,
    scheduledAt: UtcTimestamp,
  ): AutomationScheduledOccurrence {
    return {
      kind: "scheduled",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      triggerKind: definition.trigger.kind,
      scheduledAt,
      ...(definition.trigger.kind === "weekly-local"
        ? {
            resolutionEvidence: buildAutomationWeeklyResolution({
              trigger: definition.trigger,
              scheduledAt,
            }),
          }
        : {}),
    } as AutomationScheduledOccurrence;
  }

  #occurrenceKey(
    definition: AutomationDefinition,
    scheduledAt: UtcTimestamp,
  ): AutomationOccurrenceKeyText {
    return buildScheduledAutomationOccurrenceKey({
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      triggerKind: definition.trigger.kind,
      scheduledAt,
    });
  }

  #isConsumed(definition: AutomationDefinition, scheduledAt: UtcTimestamp): boolean {
    return this.#projection.isOccurrenceConsumed(
      definition.id,
      this.#occurrenceKey(definition, scheduledAt),
    );
  }

  #definition(automationId: AutomationId): AutomationDefinition | undefined {
    return this.#projection.getDefinition(automationId);
  }

  /** Fail closed: a journal that requires a snapshot must never re-claim. */
  #rehydrate(): void {
    const status = hydrateAutomationProjection({
      store: this.#store,
      projection: this.#projection,
    });
    if (status !== "ok") {
      throw new AutomationSchedulerError(
        "hydration-failed",
        "Automation journal requires a snapshot; the scheduler fails closed.",
      );
    }
  }

  #addWake(out: PassCollector, wakeMs: number): void {
    out.wakeMs = out.wakeMs === undefined ? wakeMs : Math.min(out.wakeMs, wakeMs);
  }

  #delayMsFor(summary: AutomationSchedulerPassSummary | undefined): number {
    const poll = this.#config.pollIntervalMs;
    if (summary?.nextWakeAt === undefined) return poll;
    const untilWake = parseUtc(summary.nextWakeAt) - parseUtc(this.#now());
    return Math.min(poll, Math.max(1, untilWake));
  }

  #awaitWake(delayMs: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#pokedWhileWorking) {
        this.#pokedWhileWorking = false;
        return Effect.void;
      }
      return Effect.race(
        Effect.sleep(Duration.millis(delayMs)),
        Effect.async<void>((resume) => {
          this.#notify = () => resume(Effect.void);
          return Effect.sync(() => {
            this.#notify = undefined;
          });
        }),
      );
    });
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof AutomationEventStoreError && error.category === "conflict";
}

function parseUtc(timestamp: UtcTimestamp | string): number {
  return Date.parse(timestamp);
}

function toUtc(ms: number): UtcTimestamp {
  return new Date(ms).toISOString() as UtcTimestamp;
}
