import {
  decodeAutomationFinishWaitRecord,
  deriveAutomationOccurrenceKey,
  type AutomationDefinition,
  type AutomationFinishWaitRecord,
  type AutomationId,
  type AutomationMode,
  type AutomationRun,
  type AutomationThreadFinishedOccurrence,
  type UtcTimestamp,
} from "@octant/contracts";
import { evaluateThreadFinishWait, type ThreadFinishTargetFacts } from "@octant/domain";
import type { CommittedFact } from "../remote/threadNotificationDeliveryService";
import { threadNotificationFactOf } from "../remote/threadNotificationDeliveryService";
import type { AutomationDispatchPort } from "./automationDispatchPort";
import {
  AutomationEventStoreError,
  type AutomationEventStore,
  type AutomationOccurrenceLedgerEvent,
} from "./automationEventStore";
import type { AutomationProjection } from "./automationProjection";
import {
  automationRunIdForOccurrence,
  buildAutomationRunForOccurrence,
} from "./automationRunIdentity";

export interface AutomationThreadFinishWatcherOptions {
  readonly store: Pick<
    AutomationEventStore,
    "appendOccurrenceLedger" | "appendRunCreated" | "replayEach"
  >;
  readonly projection: AutomationProjection;
  readonly dispatch: AutomationDispatchPort;
  /** Reads the host's authoritative state for one local target thread. */
  readonly readTarget: (input: {
    readonly threadId: string;
    readonly mode: AutomationMode;
    readonly projectId: string;
  }) => ThreadFinishTargetFacts;
  readonly now: () => UtcTimestamp;
  /** Settings' `followUpLatenessLimitHours`; absent defaults to 24 hours. */
  readonly latenessLimitHours?: () => number;
  /** Wakes the scheduler loop after a wait fires or transitions. */
  readonly wake?: () => void;
}

export interface ThreadFinishReconcileSummary {
  readonly firedRunIds: ReadonlyArray<AutomationRun["id"]>;
  readonly missedAutomationIds: ReadonlyArray<AutomationId>;
  readonly expiredAutomationIds: ReadonlyArray<AutomationId>;
  readonly unavailableAutomationIds: ReadonlyArray<AutomationId>;
}

const TARGET_STATE_EVENT_PREFIXES = [
  "code.thread-",
  "code.operation-",
  "code.runtime-work-",
  "work.thread-",
  "work.turn-",
  "work.request-",
  "chat.thread-",
  "chat.attempt-",
  "thread-message-queue",
  "turn-decision",
  "native-harness-",
] as const;

/**
 * Watches local committed journal facts (reusing `threadNotificationFactOf`)
 * and evaluates armed `thread-finished` waits against host-verified target
 * records. Fires each wait at most once using a deterministic run-first
 * occurrence claim, holds stale finishes as `missed`, expires past `expiresAt`,
 * and marks missing/deleted/moved targets `unavailable` without starting work.
 */
export class AutomationThreadFinishWatcher {
  readonly #store: AutomationThreadFinishWatcherOptions["store"];
  readonly #projection: AutomationProjection;
  readonly #dispatch: AutomationDispatchPort;
  readonly #readTarget: AutomationThreadFinishWatcherOptions["readTarget"];
  readonly #now: () => UtcTimestamp;
  readonly #latenessLimitHours: AutomationThreadFinishWatcherOptions["latenessLimitHours"];
  readonly #wake: AutomationThreadFinishWatcherOptions["wake"];

  constructor(options: AutomationThreadFinishWatcherOptions) {
    this.#store = options.store;
    this.#projection = options.projection;
    this.#dispatch = options.dispatch;
    this.#readTarget = options.readTarget;
    this.#now = options.now;
    this.#latenessLimitHours = options.latenessLimitHours;
    this.#wake = options.wake;
  }

  /**
   * Entry point wired to `journal.subscribeCommitted`. Performs an O(1) lookup
   * against currently armed target thread ids so commits with no matching wait
   * do no work.
   */
  onCommittedAppend(append: { readonly events: ReadonlyArray<CommittedFact> }): void {
    const armed = this.#projection.listArmedFinishWaits();
    if (armed.length === 0) return;
    const watchedTargets = new Set(armed.map((entry) => String(entry.wait.targetThreadId)));
    const touchedTargets = new Set<string>();
    for (const event of append.events) {
      const fact = threadNotificationFactOf(event);
      if (fact !== undefined && watchedTargets.has(fact.threadId)) {
        touchedTargets.add(fact.threadId);
        continue;
      }
      if (
        watchedTargets.has(event.aggregateId) &&
        TARGET_STATE_EVENT_PREFIXES.some((prefix) => event.eventName.startsWith(prefix))
      ) {
        touchedTargets.add(event.aggregateId);
        continue;
      }
      const payloadThreadId = readThreadIdFromPayload(event.payload);
      if (payloadThreadId !== undefined && watchedTargets.has(payloadThreadId)) {
        touchedTargets.add(payloadThreadId);
      }
    }
    if (touchedTargets.size === 0) return;
    for (const entry of armed) {
      if (!touchedTargets.has(String(entry.wait.targetThreadId))) continue;
      this.#evaluateOne(entry.definition.id);
    }
  }

  /**
   * Reconciles every armed finish wait against current host records. Run on
   * startup/restart and periodically by the scheduler so finishes that landed
   * while offline, expiries, and removed targets are processed cleanly.
   */
  reconcile(): ThreadFinishReconcileSummary {
    const firedRunIds: Array<AutomationRun["id"]> = [];
    const missedAutomationIds: Array<AutomationId> = [];
    const expiredAutomationIds: Array<AutomationId> = [];
    const unavailableAutomationIds: Array<AutomationId> = [];
    for (const entry of this.#projection.listArmedFinishWaits()) {
      const outcome = this.#evaluateOne(entry.definition.id);
      if (outcome.kind === "fired") firedRunIds.push(outcome.runId);
      else if (outcome.kind === "missed") missedAutomationIds.push(entry.definition.id);
      else if (outcome.kind === "expired") expiredAutomationIds.push(entry.definition.id);
      else if (outcome.kind === "unavailable") unavailableAutomationIds.push(entry.definition.id);
    }
    return {
      firedRunIds,
      missedAutomationIds,
      expiredAutomationIds,
      unavailableAutomationIds,
    };
  }

  /** Earliest delay until an armed wait expires (or a bounded poll check), if any exist. */
  nextCheckDelayMs(): number | undefined {
    const armed = this.#projection.listArmedFinishWaits();
    if (armed.length === 0) return undefined;
    const nowMs = Date.parse(this.#now());
    let delay = 15_000;
    for (const entry of armed) {
      const untilExpiry = Date.parse(entry.wait.expiresAt) - nowMs;
      delay = Math.min(delay, Math.max(1, untilExpiry));
    }
    return delay;
  }

  #evaluateOne(
    automationId: AutomationId,
  ):
    | { readonly kind: "none" }
    | { readonly kind: "fired"; readonly runId: AutomationRun["id"] }
    | { readonly kind: "missed" }
    | { readonly kind: "expired" }
    | { readonly kind: "unavailable" } {
    const definition = this.#projection.getDefinition(automationId);
    const wait = this.#projection.getFinishWait(automationId);
    if (definition === undefined || definition.lifecycle !== "enabled" || wait?.state !== "armed") {
      return { kind: "none" };
    }
    const target: ThreadFinishTargetFacts =
      wait.targetMemberId !== undefined
        ? { kind: "offline" }
        : this.#readTarget({
            threadId: String(wait.targetThreadId),
            mode: wait.targetMode,
            projectId: String(wait.targetProjectId),
          });
    const now = this.#now();
    const latenessLimitHours = this.#latenessLimitHours?.();
    const evaluation = evaluateThreadFinishWait({
      wait,
      target,
      now,
      ...(latenessLimitHours === undefined ? {} : { latenessLimitHours }),
    });
    switch (evaluation.kind) {
      case "waiting":
        return { kind: "none" };
      case "unavailable":
        this.#recordStateChange(definition, wait, {
          ...wait,
          state: "unavailable",
          updatedAt: now,
          reason: evaluation.message,
        });
        return { kind: "unavailable" };
      case "expired":
        this.#recordStateChange(definition, wait, {
          ...wait,
          state: "expired",
          updatedAt: now,
          reason: evaluation.message,
        });
        return { kind: "expired" };
      case "missed":
        this.#recordStateChange(definition, wait, {
          ...wait,
          state: "missed",
          updatedAt: now,
          attestedTurnId: evaluation.attestedTurnId as never,
          finishedAt: evaluation.finishedAt,
          reason: evaluation.message,
        });
        return { kind: "missed" };
      case "fire":
        return this.#fireOnce(
          definition,
          wait,
          evaluation.attestedTurnId,
          evaluation.finishedAt,
          now,
        );
    }
  }

  #fireOnce(
    definition: AutomationDefinition,
    wait: AutomationFinishWaitRecord,
    attestedTurnId: string,
    finishedAt: UtcTimestamp,
    now: UtcTimestamp,
  ): { readonly kind: "none" } | { readonly kind: "fired"; readonly runId: AutomationRun["id"] } {
    const occurrence: AutomationThreadFinishedOccurrence = {
      kind: "thread-finished",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      targetThreadId: wait.targetThreadId,
      attestedTurnId: attestedTurnId as never,
      finishedAt,
      waitId: wait.waitId,
    };
    const occurrenceKey = deriveAutomationOccurrenceKey(occurrence);
    if (this.#projection.isOccurrenceConsumed(definition.id, occurrenceKey)) {
      return { kind: "none" };
    }
    if (this.#projection.activeRun(definition.id) !== undefined) {
      // One active run per routine: keep waiting until the active slot frees up.
      return { kind: "none" };
    }
    const runId = automationRunIdForOccurrence(occurrenceKey);
    let run = this.#projection.getRun(runId);
    if (run === undefined) {
      const candidate = buildAutomationRunForOccurrence({ definition, occurrence, now });
      try {
        this.#store.appendRunCreated({ run: candidate });
        run = candidate;
      } catch (error) {
        if (!isConflict(error)) throw error;
        run = this.#projection.getRun(runId);
        if (run === undefined) return { kind: "none" };
      }
    }
    const firedWait = decodeAutomationFinishWaitRecord({
      ...wait,
      state: "fired",
      updatedAt: now,
      attestedTurnId,
      finishedAt,
      runId: run.id,
    });
    const events: ReadonlyArray<AutomationOccurrenceLedgerEvent> = [
      {
        kind: "finish-wait-changed",
        definitionRevision: definition.definitionRevision,
        wait: firedWait,
        previousState: "armed",
        at: now,
      },
      { kind: "occurrence-claimed", occurrence, runId: run.id, at: now },
    ];
    try {
      this.#store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: definition.version,
        events,
      });
    } catch (error) {
      if (isConflict(error)) return { kind: "none" };
      throw error;
    }
    const latestDefinition = this.#projection.getDefinition(definition.id) ?? definition;
    const latestRun = this.#projection.getRun(run.id) ?? run;
    try {
      this.#dispatch.offer({ definition: latestDefinition, run: latestRun });
    } catch {
      // The run is durably claimed; the scheduler offers it on the next pass.
    }
    this.#wake?.();
    return { kind: "fired", runId: run.id };
  }

  #recordStateChange(
    definition: AutomationDefinition,
    previous: AutomationFinishWaitRecord,
    next: AutomationFinishWaitRecord,
  ): void {
    const validated = decodeAutomationFinishWaitRecord(next);
    try {
      this.#store.appendOccurrenceLedger({
        automationId: definition.id,
        expectedVersion: definition.version,
        events: [
          {
            kind: "finish-wait-changed",
            definitionRevision: definition.definitionRevision,
            wait: validated,
            previousState: previous.state,
            at: validated.updatedAt,
          },
        ],
      });
      this.#wake?.();
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
}

function readThreadIdFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (
    "threadId" in payload &&
    typeof (payload as { readonly threadId?: unknown }).threadId === "string"
  ) {
    return (payload as { readonly threadId: string }).threadId;
  }
  return undefined;
}

function isConflict(error: unknown): boolean {
  return error instanceof AutomationEventStoreError && error.category === "conflict";
}
