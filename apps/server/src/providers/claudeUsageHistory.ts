import { Effect } from "effect";
import type {
  LocalUsageHistoryRecord,
  LocalUsageHistoryRequest,
  ProviderFailure,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { resolveLocalUsageCost, type PricingUsageRecord } from "./localUsagePricing";
import {
  readLocalUsageHistory,
  stableUsageId,
  type LocalUsageHistoryReaderOptions,
} from "./localUsageHistoryReader";

/** Read-only Claude Code transcript usage adapter; it ignores message text. */
export function createClaudeLocalUsageHistorySource(
  options: Omit<LocalUsageHistoryReaderOptions, "sourceKind" | "providerKey">,
): ProviderLocalUsageHistorySource {
  return {
    sourceKind: "claude-code",
    read: (request: LocalUsageHistoryRequest, signal) =>
      Effect.tryPromise({
        try: (effectSignal) =>
          readLocalUsageHistory(
            { ...options, sourceKind: "claude-code", providerKey: "claude-code" },
            request,
            parseClaudeLine,
            signal ?? effectSignal,
          ),
        catch: (): ProviderFailure => ({
          category: "provider-failed",
          message: "Claude Code local usage history could not be read.",
        }),
      }),
  };
}

function parseClaudeLine(input: {
  readonly line: string;
  readonly sourceInstallationId: string;
  readonly sourceSessionIdHint: string;
  readonly relativePath: string;
  readonly lineNumber: number;
}): LocalUsageHistoryRecord | undefined {
  const value = parseRecord(input.line);
  if (value?.type !== "assistant") return undefined;
  const message = record(value.message);
  const usage = record(message?.usage) ?? record(value.usage);
  if (usage === undefined) return undefined;
  const uncachedInputTokens = nonNegativeInt(usage.input_tokens);
  const outputTokens = nonNegativeInt(usage.output_tokens);
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadInputTokens = nonNegativeInt(usage.cache_read_input_tokens);
  const cacheCreation = record(usage.cache_creation);
  const cacheWriteInputTokens =
    nonNegativeInt(usage.cache_creation_input_tokens) ??
    (cacheCreation === undefined
      ? undefined
      : (nonNegativeInt(cacheCreation.ephemeral_5m_input_tokens) ?? 0) +
        (nonNegativeInt(cacheCreation.ephemeral_1h_input_tokens) ?? 0));
  const cacheWriteDuration =
    cacheCreation === undefined
      ? undefined
      : nonNegativeInt(cacheCreation.ephemeral_5m_input_tokens) !== undefined &&
          nonNegativeInt(cacheCreation.ephemeral_1h_input_tokens) === undefined
        ? ("5-minute" as const)
        : nonNegativeInt(cacheCreation.ephemeral_1h_input_tokens) !== undefined &&
            nonNegativeInt(cacheCreation.ephemeral_5m_input_tokens) === undefined
          ? ("1-hour" as const)
          : ("unknown" as const);
  const inputTokens =
    uncachedInputTokens + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) return undefined;
  const observedAt = timestamp(value.timestamp) ?? timestamp(value.created_at);
  if (observedAt === undefined) return undefined;
  const sourceSessionId =
    text(value.session_id) ?? text(value.sessionId) ?? sessionIdFromPath(input.sourceSessionIdHint);
  const sourceEventId =
    text(message?.id) ??
    text(value.request_id) ??
    stableUsageId("claude-code", sourceSessionId, observedAt, JSON.stringify(usage));
  const modelId = text(message?.model) ?? text(value.model) ?? "unknown";
  const costUsd = nonNegativeNumber(value.cost_usd) ?? nonNegativeNumber(value.costUsd);
  const pricingRecord: PricingUsageRecord = {
    modelId,
    inputTokens,
    uncachedInputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cacheWriteDuration === undefined || cacheWriteDuration === "unknown"
      ? {}
      : { cacheWriteDuration }),
    outputTokens,
    ...(costUsd === undefined
      ? {}
      : { cost: { amount: costUsd, currency: "USD" as const, kind: "api-estimate" as const } }),
  };
  const cost = localCost("anthropic", pricingRecord);
  return {
    sourceKind: "claude-code",
    sourceInstallationId: input.sourceInstallationId,
    sourceSessionId,
    sourceEventId,
    providerKey: "claude-code",
    modelId,
    observedAt,
    inputTokens,
    uncachedInputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(cacheWriteDuration === undefined ? {} : { cacheWriteDuration }),
    outputTokens,
    ...(cost === undefined ? {} : { cost }),
  };
}

function localCost(
  provider: "anthropic",
  record: PricingUsageRecord,
): LocalUsageHistoryRecord["cost"] {
  const resolved = resolveLocalUsageCost(provider, record);
  if (resolved.kind === "unpriced") return undefined;
  return {
    ...resolved.cost,
    ...(resolved.kind === "api-estimate" && resolved.estimate !== undefined
      ? {
          pricingRevision: resolved.estimate.pricingRevision,
          pricingSource: resolved.estimate.source.url,
        }
      : {}),
  };
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return record(value);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : undefined;
}

function timestamp(value: unknown): UtcTimestamp | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString() as UtcTimestamp;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sessionIdFromPath(value: string): string {
  return value.slice(0, 512);
}
