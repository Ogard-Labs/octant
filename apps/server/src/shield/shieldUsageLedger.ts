import {
  CorrelationId,
  EventId,
  SHIELD_REVIEW_REQUEST_SHAPE,
  SHIELD_REVIEW_USAGE_AGGREGATE_TYPE,
  decodeUsageReconciliation,
  decodeUtcTimestamp,
  type ProviderInstanceId,
  type ProviderModelId,
  type TurnUsage,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { ledgerUsageCost } from "@octant/domain/turn-metrics-display";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);

/**
 * Journals what one Octant Shield review's model call spent, so the usage
 * ledger records it under the reviewed Code thread and that thread's and its
 * Project's spend ceilings count it. A review has no context plan, so it
 * reconciles against nothing. It is priced by the rule Chat and Work use, and
 * a call that reported no usage (a timeout, a provider that says nothing) is
 * recorded as unreported and unpriced rather than free, so a ceiling with a
 * budget counts it as unknown spend.
 */
export function recordShieldReviewUsage(
  ledger: OneShotUsageLedger,
  input: OneShotUsageInput,
): void {
  recordOneShotUsage(ledger, {
    ...input,
    aggregateType: SHIELD_REVIEW_USAGE_AGGREGATE_TYPE,
    requestShape: SHIELD_REVIEW_REQUEST_SHAPE,
  });
}

export interface OneShotUsageLedger {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly clock: () => string;
  readonly uuid: () => string;
}

export interface OneShotUsageInput {
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly usage?: TurnUsage | undefined;
}

/**
 * One host-made model call with no context plan (a Shield review, a
 * person-memory distillation), journaled on its own per-thread aggregate so
 * the usage ledger records it under the thread it was for, by the same pricing
 * and unreported-usage rules as a review.
 */
export function recordOneShotUsage(
  ledger: OneShotUsageLedger,
  input: OneShotUsageInput & { readonly aggregateType: string; readonly requestShape: string },
): void {
  const { usage } = input;
  const observedAt = decodeUtcTimestamp(ledger.clock());
  const cost = usage === undefined ? undefined : ledgerUsageCost(String(input.modelId), usage);
  const reconciliation = decodeUsageReconciliation({
    id: ledger.uuid(),
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    requestShape: input.requestShape,
    plannedInputTokens: usage?.inputTokens ?? 0,
    actualInputTokens: usage?.inputTokens ?? 0,
    actualOutputTokens: usage?.outputTokens ?? 0,
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage?.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage?.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage === undefined ? { providerReported: false } : {}),
    ...(cost === undefined ? {} : { cost }),
    varianceTokens: 0,
    observedAt,
  });
  ledger.journal.append({
    aggregate: { aggregateType: input.aggregateType, aggregateId: input.threadId },
    expectedVersion: readAggregateVersion(ledger.connection, input.aggregateType, input.threadId),
    events: [
      {
        eventId: decodeEventId(ledger.uuid()),
        eventName: "context.usage-reconciled@1",
        eventVersion: 1,
        hostId: LOCAL_HOST_ID,
        correlationId: decodeCorrelationId(ledger.uuid()),
        actor: { kind: "system" as const, actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: observedAt,
        payload: { reconciliation },
      },
    ],
  });
}
