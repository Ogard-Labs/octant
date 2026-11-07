import type {
  NativeHarnessTurnStopReason,
  OctantMode,
  ProjectId,
  PromptDigest,
  ProviderInstanceId,
  ProviderModelId,
  TurnDiagnostics,
  TurnMetrics,
  TurnMetricsRecord,
  TurnStopReason,
  TurnUsage,
  UtcTimestamp,
} from "@octant/contracts";
import { finishTurnMetrics, type TurnMetricsState } from "@octant/domain";

/**
 * Everything a turn leaves behind once it has ended: how it stopped, when it
 * really started and ended, what the provider reported it cost, and how fast
 * it ran. Built once by the runner that watched the provider's events, so
 * every consumer reads the same figures.
 */
export interface TurnEndSummary {
  readonly stopReason: TurnStopReason;
  readonly startedAt: string;
  readonly endedAt: string;
  /** Absent when the provider reported no usage. */
  readonly usage?: TurnUsage | undefined;
  readonly metrics: TurnMetrics;
  /** Tool, retry, limit, and failure counts from the same events as the timing. */
  readonly diagnostics?: TurnDiagnostics | undefined;
  /** The keyed digest of the prompt this turn sent; absent when the host has no digest key. */
  readonly promptDigest?: string | undefined;
}

/**
 * The turn with the digest of the prompt it sent, set by whoever knows that
 * prompt (the runner's caller). Without a digest function the turn is returned
 * as it is.
 */
export function withPromptDigest(
  turn: TurnEndSummary,
  digest: ((text: string) => string) | undefined,
  prompt: string,
): TurnEndSummary {
  return digest === undefined ? turn : { ...turn, promptDigest: digest(prompt) };
}

export function summarizeTurnEnd(input: {
  readonly metrics: TurnMetricsState;
  readonly stopReason: TurnStopReason;
  readonly startedAt: string;
  readonly endedAt: string;
}): TurnEndSummary {
  const finished = finishTurnMetrics(input.metrics, input.endedAt);
  return {
    stopReason: input.stopReason,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ...(finished.usage === undefined ? {} : { usage: finished.usage }),
    metrics: finished.metrics,
    diagnostics: finished.diagnostics,
  };
}

export interface TurnEndScope {
  readonly threadId: string;
  readonly mode: OctantMode;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly projectId?: ProjectId | undefined;
}

export function toTurnMetricsRecord(scope: TurnEndScope, turn: TurnEndSummary): TurnMetricsRecord {
  return {
    threadId: scope.threadId,
    mode: scope.mode,
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    providerInstanceId: scope.providerInstanceId,
    modelId: scope.modelId,
    stopReason: turn.stopReason,
    ...(turn.usage === undefined ? {} : { usage: turn.usage }),
    metrics: turn.metrics,
    ...(turn.diagnostics === undefined ? {} : { diagnostics: turn.diagnostics }),
    ...(turn.promptDigest === undefined ? {} : { promptDigest: turn.promptDigest as PromptDigest }),
    startedAt: turn.startedAt as UtcTimestamp,
    endedAt: turn.endedAt as UtcTimestamp,
  };
}

/** The harness session's vocabulary for how a turn stopped. */
export function harnessStopReason(reason: TurnStopReason): NativeHarnessTurnStopReason {
  switch (reason) {
    case "end-of-turn":
      return "end-of-turn";
    case "max-tokens":
      return "max-tokens";
    case "cancelled":
      return "user-interrupt";
    case "failed":
    case "waiting":
      return "provider-failure";
  }
}
