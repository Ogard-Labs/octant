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
  ledger: {
    readonly connection: SqliteConnection;
    readonly journal: Journal;
    readonly clock: () => string;
    readonly uuid: () => string;
  },
  input: {
    readonly threadId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly usage?: TurnUsage | undefined;
  },
): void {
  const { usage } = input;
  const observedAt = decodeUtcTimestamp(ledger.clock());
  const cost = usage === undefined ? undefined : ledgerUsageCost(String(input.modelId), usage);
  const reconciliation = decodeUsageReconciliation({
    id: ledger.uuid(),
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    requestShape: SHIELD_REVIEW_REQUEST_SHAPE,
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
    aggregate: { aggregateType: SHIELD_REVIEW_USAGE_AGGREGATE_TYPE, aggregateId: input.threadId },
    expectedVersion: readAggregateVersion(
      ledger.connection,
      SHIELD_REVIEW_USAGE_AGGREGATE_TYPE,
      input.threadId,
    ),
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
