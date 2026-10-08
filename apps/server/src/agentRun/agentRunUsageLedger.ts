import {
  AGENT_RUN_TURN_REQUEST_SHAPE,
  AGENT_RUN_USAGE_AGGREGATE_TYPE,
  CorrelationId,
  EventId,
  decodeUsageReconciliation,
  decodeUtcTimestamp,
  type AgentRunId,
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
 * Journals what one child turn spent, so the usage ledger records it under the
 * run's `agent-run` subject and every thread and Project spend ceiling that
 * covers the run counts it. The child path has no context plan, so the turn
 * reconciles against nothing: its planned input is its actual input. It is
 * priced by the rule Chat and Work use (`ledgerUsageCost`), and a turn that
 * reported no usage is recorded as unreported and unpriced rather than free.
 */
export function recordAgentRunTurnUsage(
  ledger: {
    readonly connection: SqliteConnection;
    readonly journal: Journal;
    readonly clock: () => string;
    readonly uuid: () => string;
  },
  input: {
    readonly runId: AgentRunId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly usage?: TurnUsage;
  },
): void {
  const { usage } = input;
  const observedAt = decodeUtcTimestamp(ledger.clock());
  const cost = usage === undefined ? undefined : ledgerUsageCost(String(input.modelId), usage);
  const reconciliation = decodeUsageReconciliation({
    id: ledger.uuid(),
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    requestShape: AGENT_RUN_TURN_REQUEST_SHAPE,
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
  const aggregateId = String(input.runId);
  ledger.journal.append({
    aggregate: { aggregateType: AGENT_RUN_USAGE_AGGREGATE_TYPE, aggregateId },
    expectedVersion: readAggregateVersion(
      ledger.connection,
      AGENT_RUN_USAGE_AGGREGATE_TYPE,
      aggregateId,
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
