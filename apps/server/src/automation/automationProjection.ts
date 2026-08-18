import {
  AutomationBlocked,
  AutomationDefinitionCreated,
  AutomationDefinitionExhausted,
  AutomationDefinitionLifecycleChanged,
  AutomationDefinitionUpdated,
  AutomationDispatchIntentRecorded,
  AutomationFirstTurnAccepted,
  AutomationFirstTurnDispatchCancelled,
  AutomationFirstTurnRuntimeClaimed,
  AutomationOccurrenceClaimed,
  AutomationOccurrenceSkipped,
  AutomationRunCreated,
  AutomationRunStatusChanged,
  AutomationNotificationRefRecorded,
  MAX_AUTOMATION_HISTORY_ENTRIES,
  MAX_AUTOMATION_NOTIFICATION_REFERENCES,
  MAX_AUTOMATION_QUERY_LIMIT,
  type AutomationDefinition,
  type AutomationId,
  type AutomationOccurrenceKeyText,
  type AutomationRun,
  type AutomationRunId,
  type AutomationScheduledOccurrence,
  type AutomationSummary,
  type AutomationWeeklyResolution,
  type EventEnvelope,
  type HostId,
  type ProjectId,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  buildAutomationWeeklyResolution,
  isAutomationRunLifecycleActive,
  resolveNextAutomationOccurrence,
} from "@octant/domain";
import { Schema } from "effect";
import { ReplayEventInvalid } from "../persistence/journalErrors";
import type { Projection } from "../persistence/projection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { AutomationEventStore } from "./automationEventStore";
import {
  AUTOMATION_BLOCKED,
  AUTOMATION_DEFINITION_CREATED,
  AUTOMATION_DEFINITION_EXHAUSTED,
  AUTOMATION_DEFINITION_LIFECYCLE_CHANGED,
  AUTOMATION_DEFINITION_UPDATED,
  AUTOMATION_DISPATCH_INTENT_RECORDED,
  AUTOMATION_FIRST_TURN_ACCEPTED,
  AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED,
  AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED,
  AUTOMATION_NOTIFICATION_REF_RECORDED,
  AUTOMATION_OCCURRENCE_CLAIMED,
  AUTOMATION_OCCURRENCE_SKIPPED,
  AUTOMATION_RUN_CREATED,
  AUTOMATION_RUN_STATUS_CHANGED,
} from "./automationEventStore";

const decodeDefinitionCreated = Schema.decodeUnknownSync(AutomationDefinitionCreated);
const decodeDefinitionUpdated = Schema.decodeUnknownSync(AutomationDefinitionUpdated);
const decodeDefinitionLifecycleChanged = Schema.decodeUnknownSync(
  AutomationDefinitionLifecycleChanged,
);
const decodeDefinitionExhausted = Schema.decodeUnknownSync(AutomationDefinitionExhausted);
const decodeOccurrenceClaimed = Schema.decodeUnknownSync(AutomationOccurrenceClaimed);
const decodeOccurrenceSkipped = Schema.decodeUnknownSync(AutomationOccurrenceSkipped);
const decodeBlocked = Schema.decodeUnknownSync(AutomationBlocked);
const decodeRunCreated = Schema.decodeUnknownSync(AutomationRunCreated);
const decodeRunStatusChanged = Schema.decodeUnknownSync(AutomationRunStatusChanged);
const decodeDispatchCancelled = Schema.decodeUnknownSync(AutomationFirstTurnDispatchCancelled);
const decodeDispatchIntentRecorded = Schema.decodeUnknownSync(AutomationDispatchIntentRecorded);
const decodeFirstTurnRuntimeClaimed = Schema.decodeUnknownSync(AutomationFirstTurnRuntimeClaimed);
const decodeFirstTurnAccepted = Schema.decodeUnknownSync(AutomationFirstTurnAccepted);
const decodeNotificationRefRecorded = Schema.decodeUnknownSync(AutomationNotificationRefRecorded);

/**
 * Bound on retained consumed-occurrence keys per Automation. The due ledger
 * advances past consumed occurrences, so old keys only matter for replayed
 * or raced frames near the current schedule head.
 */
const MAX_CONSUMED_OCCURRENCE_KEYS = 1_024;

export interface ListAutomationSummariesInput {
  readonly hostId: HostId;
  readonly mode: "all" | "work" | "code";
  readonly projectId?: ProjectId | undefined;
  readonly search?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface AutomationSummaryPage {
  readonly items: ReadonlyArray<AutomationSummary>;
  readonly nextCursor?: string;
}

export interface ListAutomationRunsInput {
  readonly automationId: AutomationId;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface AutomationRunPage {
  readonly runs: ReadonlyArray<AutomationRun>;
  readonly nextCursor?: string;
}

/**
 * Rebuildable in-memory Automation projection. Replays journaled definition
 * and run events into bounded, sanitized query state: summaries never carry
 * prompts, bindings, execution/authority profiles, or delivery targets, and
 * run history is capped per Automation with newest-first cursor pagination.
 * Idempotent: a frame whose version is not strictly newer than the current
 * aggregate head is ignored, so duplicate or replayed frames never roll
 * state back. Archive keeps the definition and its history queryable.
 *
 * Scheduler frames extend the same aggregates: occurrence claims and skips
 * advance the recurring due ledger and record consumed occurrence keys,
 * blocked receipts pause the definition with a typed reason, and dispatch
 * intent/launch-claim/acceptance receipts attach to the run so recovery can
 * distinguish a committed thread receipt from an expired pre-thread claim.
 */
export class AutomationProjection implements Projection {
  readonly name = "automations";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly #definitions = new Map<AutomationId, AutomationDefinition>();
  readonly #runs = new Map<AutomationRunId, AutomationRun>();
  readonly #runsByAutomation = new Map<AutomationId, Set<AutomationRunId>>();
  readonly #consumedOccurrences = new Map<AutomationId, Set<AutomationOccurrenceKeyText>>();

  reset(_connection: SqliteConnection): void {
    this.clear();
  }

  clear(): void {
    this.#definitions.clear();
    this.#runs.clear();
    this.#runsByAutomation.clear();
    this.#consumedOccurrences.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    this.applyEnvelope(event);
  }

  applyEnvelope(event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    switch (event.eventName) {
      case AUTOMATION_DEFINITION_CREATED:
        this.#upsertDefinition(decodeDefinitionCreated(event.payload).automation);
        return;
      case AUTOMATION_DEFINITION_UPDATED:
        this.#upsertDefinition(decodeDefinitionUpdated(event.payload).automation);
        return;
      case AUTOMATION_DEFINITION_LIFECYCLE_CHANGED:
        this.#upsertDefinition(decodeDefinitionLifecycleChanged(event.payload).automation);
        return;
      case AUTOMATION_DEFINITION_EXHAUSTED:
        this.#applyDefinitionExhausted(event);
        return;
      case AUTOMATION_OCCURRENCE_CLAIMED:
        this.#applyOccurrenceClaimed(event);
        return;
      case AUTOMATION_OCCURRENCE_SKIPPED:
        this.#applyOccurrenceSkipped(event);
        return;
      case AUTOMATION_BLOCKED:
        this.#applyBlocked(event);
        return;
      case AUTOMATION_RUN_CREATED:
        this.#applyRunCreated(decodeRunCreated(event.payload).run);
        return;
      case AUTOMATION_RUN_STATUS_CHANGED:
        this.#applyRunStatusChanged(event);
        return;
      case AUTOMATION_FIRST_TURN_DISPATCH_CANCELLED:
        this.#applyRunCancellationTombstone(event);
        return;
      case AUTOMATION_DISPATCH_INTENT_RECORDED:
        this.#applyDispatchIntentRecorded(event);
        return;
      case AUTOMATION_FIRST_TURN_RUNTIME_CLAIMED:
        this.#applyFirstTurnRuntimeClaimed(event);
        return;
      case AUTOMATION_FIRST_TURN_ACCEPTED:
        this.#applyFirstTurnAccepted(event);
        return;
      case AUTOMATION_NOTIFICATION_REF_RECORDED:
        this.#applyNotificationRefRecorded(event);
        return;
      default:
        // Unknown automation frames belong to newer sibling slices; this
        // projection tolerates them so replay never quarantines on them.
        return;
    }
  }

  getDefinition(automationId: AutomationId): AutomationDefinition | undefined {
    return this.#definitions.get(automationId);
  }

  /** Every projected definition, for scheduler passes over the whole host. */
  listDefinitions(): ReadonlyArray<AutomationDefinition> {
    return [...this.#definitions.values()];
  }

  getRun(runId: AutomationRunId): AutomationRun | undefined {
    return this.#runs.get(runId);
  }

  /** True when a claim or skip receipt already consumed the occurrence. */
  isOccurrenceConsumed(
    automationId: AutomationId,
    occurrenceKey: AutomationOccurrenceKeyText,
  ): boolean {
    return this.#consumedOccurrences.get(automationId)?.has(occurrenceKey) ?? false;
  }

  /** Newest run for the Automation, regardless of lifecycle. */
  latestRun(automationId: AutomationId): AutomationRun | undefined {
    return this.#runsNewestFirst(automationId)[0];
  }

  /** Newest run still occupying the Automation's single active slot. */
  activeRun(automationId: AutomationId): AutomationRun | undefined {
    return this.#runsNewestFirst(automationId).find((run) =>
      isAutomationRunLifecycleActive(run.lifecycle),
    );
  }

  listSummaries(input: ListAutomationSummariesInput): AutomationSummaryPage {
    const limit = clampLimit(input.limit, MAX_AUTOMATION_QUERY_LIMIT);
    const search = input.search?.toLowerCase();
    const matches = [...this.#definitions.values()]
      .filter((definition) => {
        if (String(definition.hostId) !== String(input.hostId)) return false;
        if (input.mode !== "all" && definition.mode !== input.mode) return false;
        if (
          input.projectId !== undefined &&
          String(definition.projectId) !== String(input.projectId)
        ) {
          return false;
        }
        if (search !== undefined && !definition.displayName.toLowerCase().includes(search)) {
          return false;
        }
        return true;
      })
      .sort(byNewestFirst((definition) => cursorKey(definition.updatedAt, definition.id)));
    const page = paginate(
      matches,
      (definition) => cursorKey(definition.updatedAt, definition.id),
      limit,
      input.cursor,
    );
    return {
      items: page.items.map((definition) => this.#summarize(definition)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  listRuns(input: ListAutomationRunsInput): AutomationRunPage {
    const limit = clampLimit(input.limit, MAX_AUTOMATION_HISTORY_ENTRIES);
    const page = paginate(
      this.#runsNewestFirst(input.automationId),
      (run) => cursorKey(run.createdAt, run.id),
      limit,
      input.cursor,
    );
    return {
      runs: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  #summarize(definition: AutomationDefinition): AutomationSummary {
    const latest = this.latestRun(definition.id);
    return {
      id: definition.id,
      displayName: definition.displayName,
      hostId: definition.hostId,
      mode: definition.mode,
      projectId: definition.projectId,
      lifecycle: definition.lifecycle,
      trigger: definition.trigger,
      definitionRevision: definition.definitionRevision,
      nextDueAt: definition.nextDueAt,
      ...(latest === undefined ? {} : { latestRunLifecycle: latest.lifecycle }),
      version: definition.version,
      updatedAt: definition.updatedAt,
    } as AutomationSummary;
  }

  #upsertDefinition(definition: AutomationDefinition): void {
    const existing = this.#definitions.get(definition.id);
    if (existing !== undefined && existing.version >= definition.version) return;
    this.#definitions.set(definition.id, definition);
  }

  #applyDefinitionExhausted(event: EventEnvelope): void {
    const payload = decodeDefinitionExhausted(event.payload);
    const existing = this.#definitions.get(payload.automationId);
    if (existing === undefined || existing.version >= payload.version) return;
    const { nextDueResolution: _resolution, ...rest } = existing;
    this.#definitions.set(payload.automationId, {
      ...rest,
      lifecycle: "exhausted",
      nextDueAt: null,
      version: payload.version,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationDefinition);
  }

  #applyOccurrenceClaimed(event: EventEnvelope): void {
    const payload = decodeOccurrenceClaimed(event.payload);
    this.#markConsumed(payload.automationId, payload.occurrenceKey);
    this.#consumeScheduledOccurrence(
      payload.automationId,
      payload.occurrence.kind === "scheduled" ? payload.occurrence : undefined,
      event,
    );
  }

  #applyOccurrenceSkipped(event: EventEnvelope): void {
    const payload = decodeOccurrenceSkipped(event.payload);
    this.#markConsumed(payload.automationId, payload.occurrenceKey);
    this.#consumeScheduledOccurrence(payload.automationId, payload.occurrence, event);
  }

  /**
   * Advance the durable due ledger past one consumed scheduled occurrence.
   * A once trigger keeps its configured instant until exhaustion clears it,
   * and an occurrence from a superseded definition revision never mutates the
   * newer revision's schedule; both still advance the aggregate version so the
   * projection stays aligned with the journal head.
   */
  #consumeScheduledOccurrence(
    automationId: AutomationId,
    occurrence: AutomationScheduledOccurrence | undefined,
    event: EventEnvelope,
  ): void {
    const existing = this.#definitions.get(automationId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    const advance =
      occurrence !== undefined &&
      occurrence.definitionRevision === existing.definitionRevision &&
      existing.lifecycle === "enabled" &&
      existing.trigger.kind !== "once"
        ? nextDueStateAfter(existing.trigger, occurrence.scheduledAt)
        : undefined;
    const { nextDueResolution: _resolution, ...rest } = existing;
    this.#definitions.set(automationId, {
      ...rest,
      ...(advance === undefined
        ? existing.nextDueResolution === undefined
          ? {}
          : { nextDueResolution: existing.nextDueResolution }
        : advance),
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationDefinition);
  }

  #applyBlocked(event: EventEnvelope): void {
    const payload = decodeBlocked(event.payload);
    const existing = this.#definitions.get(payload.automationId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    const { nextDueResolution: _resolution, ...rest } = existing;
    this.#definitions.set(payload.automationId, {
      ...rest,
      lifecycle: "paused",
      blockedReason: payload.reason,
      nextDueAt: null,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationDefinition);
  }

  #markConsumed(automationId: AutomationId, occurrenceKey: AutomationOccurrenceKeyText): void {
    const keys = this.#consumedOccurrences.get(automationId) ?? new Set();
    keys.add(occurrenceKey);
    while (keys.size > MAX_CONSUMED_OCCURRENCE_KEYS) {
      const oldest = keys.values().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
    }
    this.#consumedOccurrences.set(automationId, keys);
  }

  #applyRunCreated(run: AutomationRun): void {
    const existing = this.#runs.get(run.id);
    if (existing !== undefined && existing.version >= run.version) return;
    this.#indexRun(run);
  }

  #applyRunStatusChanged(event: EventEnvelope): void {
    const payload = decodeRunStatusChanged(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= payload.version) return;
    const { failure: _failure, ...rest } = existing;
    this.#indexRun({
      ...rest,
      lifecycle: payload.lifecycle,
      ...(payload.failure === undefined ? {} : { failure: payload.failure }),
      version: payload.version,
      updatedAt: payload.updatedAt,
    } as AutomationRun);
  }

  #applyRunCancellationTombstone(event: EventEnvelope): void {
    const payload = decodeDispatchCancelled(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    // The paired terminal status frame lands in the same committed append;
    // this intermediate state only records the receipt and version.
    this.#indexRun({
      ...existing,
      cancellationTombstone: payload.tombstone,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationRun);
  }

  #applyDispatchIntentRecorded(event: EventEnvelope): void {
    const payload = decodeDispatchIntentRecorded(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    this.#indexRun({
      ...existing,
      threadId: payload.intent.threadId,
      dispatchIntent: payload.intent,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationRun);
  }

  #applyFirstTurnRuntimeClaimed(event: EventEnvelope): void {
    const payload = decodeFirstTurnRuntimeClaimed(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    this.#indexRun({
      ...existing,
      runtimeLaunchClaim: payload.claim,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationRun);
  }

  #applyFirstTurnAccepted(event: EventEnvelope): void {
    const payload = decodeFirstTurnAccepted(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= event.aggregateVersion) return;
    this.#indexRun({
      ...existing,
      firstTurnAcceptance: payload.receipt,
      version: event.aggregateVersion,
      updatedAt: event.occurredAt as UtcTimestamp,
    } as AutomationRun);
  }

  #applyNotificationRefRecorded(event: EventEnvelope): void {
    const payload = decodeNotificationRefRecorded(event.payload);
    const existing = this.#runs.get(payload.runId);
    if (existing === undefined || existing.version >= payload.version) return;
    if (existing.notificationRefs.includes(payload.notificationRef)) {
      this.#indexRun({
        ...existing,
        version: payload.version,
        updatedAt: payload.recordedAt,
      } as AutomationRun);
      return;
    }
    const nextRefs = [...existing.notificationRefs, payload.notificationRef].slice(
      -MAX_AUTOMATION_NOTIFICATION_REFERENCES,
    );
    this.#indexRun({
      ...existing,
      notificationRefs: nextRefs,
      version: payload.version,
      updatedAt: payload.recordedAt,
    } as AutomationRun);
  }

  #indexRun(run: AutomationRun): void {
    this.#runs.set(run.id, run);
    const ids = this.#runsByAutomation.get(run.automationId) ?? new Set<AutomationRunId>();
    ids.add(run.id);
    this.#runsByAutomation.set(run.automationId, ids);
    this.#evictOverflow(run.automationId, ids);
  }

  /** Cap retained history per Automation, dropping the oldest runs first. */
  #evictOverflow(automationId: AutomationId, ids: Set<AutomationRunId>): void {
    if (ids.size <= MAX_AUTOMATION_HISTORY_ENTRIES) return;
    const ordered = this.#runsNewestFirst(automationId);
    for (const run of ordered.slice(MAX_AUTOMATION_HISTORY_ENTRIES)) {
      ids.delete(run.id);
      this.#runs.delete(run.id);
    }
  }

  #runsNewestFirst(automationId: AutomationId): ReadonlyArray<AutomationRun> {
    const ids = this.#runsByAutomation.get(automationId);
    if (ids === undefined) return [];
    const runs: Array<AutomationRun> = [];
    for (const id of ids) {
      const run = this.#runs.get(id);
      if (run !== undefined) runs.push(run);
    }
    return runs.sort(byNewestFirst((run) => cursorKey(run.createdAt, run.id)));
  }
}

export interface HydrateAutomationProjectionInput {
  readonly store: Pick<AutomationEventStore, "replayAll">;
  readonly projection: AutomationProjection;
}

/**
 * Rebuild the in-memory Automation projection from the authoritative journal
 * at startup or reconnect. Fails closed: a malformed, misattributed, or
 * undecodable frame leaves the projection empty and reports
 * `snapshot-required` instead of trusting a partially valid stream.
 */
export function hydrateAutomationProjection(
  input: HydrateAutomationProjectionInput,
): "ok" | "snapshot-required" {
  let replay: ReturnType<AutomationEventStore["replayAll"]>;
  try {
    replay = input.store.replayAll();
  } catch (error) {
    if (error instanceof ReplayEventInvalid) return "snapshot-required";
    throw error;
  }
  if (replay.status !== "ok") return "snapshot-required";
  input.projection.clear();
  for (const envelope of replay.events) {
    input.projection.applyEnvelope(envelope);
  }
  return "ok";
}

interface DueLedgerState {
  readonly nextDueAt: UtcTimestamp | null;
  readonly nextDueResolution?: AutomationWeeklyResolution;
}

/**
 * Recompute the recurring due ledger strictly after one consumed occurrence.
 * The consumed occurrence's own instant is the persisted evidence; the next
 * due value is rebuildable projection state. Fails soft: a policy rejection
 * (for example malformed timezone data) leaves the ledger unchanged instead
 * of quarantining the projection.
 */
function nextDueStateAfter(
  trigger: AutomationDefinition["trigger"],
  after: UtcTimestamp,
): DueLedgerState | undefined {
  try {
    const nextDueAt = resolveNextAutomationOccurrence({ trigger, after });
    if (nextDueAt === undefined) return { nextDueAt: null };
    if (trigger.kind === "weekly-local") {
      return {
        nextDueAt,
        nextDueResolution: buildAutomationWeeklyResolution({ trigger, scheduledAt: nextDueAt }),
      };
    }
    return { nextDueAt };
  } catch {
    return undefined;
  }
}

/**
 * Opaque descending cursor position: an ISO-8601 UTC timestamp orders
 * lexicographically, and the stable id breaks same-instant ties
 * deterministically across rebuilds.
 */
function cursorKey(timestamp: UtcTimestamp, id: string): string {
  return `${timestamp}~${id}`;
}

function byNewestFirst<T>(key: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => key(right).localeCompare(key(left));
}

function paginate<T>(
  ordered: ReadonlyArray<T>,
  key: (value: T) => string,
  limit: number,
  cursor: string | undefined,
): { readonly items: ReadonlyArray<T>; readonly nextCursor?: string } {
  const window = cursor === undefined ? ordered : ordered.filter((value) => key(value) < cursor);
  const items = window.slice(0, limit);
  const last = items[items.length - 1];
  if (window.length <= items.length || last === undefined) return { items };
  return { items, nextCursor: key(last) };
}

function clampLimit(limit: number, max: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 1;
  return Math.min(limit, max);
}
