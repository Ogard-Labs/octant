import { Effect } from "effect";
import type {
  LocalUsageHistoryRecord,
  LocalUsageHistoryRequest,
  ProviderFailure,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
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
    read: (request: LocalUsageHistoryRequest) =>
      Effect.tryPromise({
        try: () =>
          readLocalUsageHistory(
            { ...options, sourceKind: "claude-code", providerKey: "claude-code" },
            request,
            parseClaudeLine,
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
  const cost =
    costUsd === undefined
      ? claudeApiEstimate({
          modelId,
          uncachedInputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
          cacheWriteDuration,
          outputTokens,
        })
      : {
          amount: costUsd,
          currency: "USD" as const,
          kind: "api-estimate" as const,
          pricingRevision: "claude-log-2026-09-09",
          pricingSource: "https://code.claude.com/docs/en/monitoring-usage",
        };
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

function claudeApiEstimate(input: {
  readonly modelId: string;
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number | undefined;
  readonly cacheWriteInputTokens: number | undefined;
  readonly cacheWriteDuration: "5-minute" | "1-hour" | "unknown" | undefined;
  readonly outputTokens: number;
}): LocalUsageHistoryRecord["cost"] {
  const pricing = [
    { prefix: "claude-opus-5", input: 5, read: 0.5, write5m: 6.25, write1h: 10, output: 25 },
    { prefix: "claude-opus-4.8", input: 5, read: 0.5, write5m: 6.25, write1h: 10, output: 25 },
    { prefix: "claude-opus-4.7", input: 5, read: 0.5, write5m: 6.25, write1h: 10, output: 25 },
    { prefix: "claude-opus-4.6", input: 5, read: 0.5, write5m: 6.25, write1h: 10, output: 25 },
    { prefix: "claude-opus-4.5", input: 5, read: 0.5, write5m: 6.25, write1h: 10, output: 25 },
    { prefix: "claude-sonnet-5", input: 2, read: 0.2, write5m: 2.5, write1h: 4, output: 10 },
    { prefix: "claude-sonnet-4.6", input: 3, read: 0.3, write5m: 3.75, write1h: 6, output: 15 },
    { prefix: "claude-sonnet-4.5", input: 3, read: 0.3, write5m: 3.75, write1h: 6, output: 15 },
    { prefix: "claude-haiku-4.5", input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 },
  ].find((candidate) => input.modelId.startsWith(candidate.prefix));
  if (pricing === undefined) return undefined;
  if ((input.cacheWriteInputTokens ?? 0) > 0 && input.cacheWriteDuration === undefined)
    return undefined;
  if ((input.cacheWriteInputTokens ?? 0) > 0 && input.cacheWriteDuration === "unknown")
    return undefined;
  const writeRate = input.cacheWriteDuration === "1-hour" ? pricing.write1h : pricing.write5m;
  const amount =
    (input.uncachedInputTokens * pricing.input +
      (input.cacheReadInputTokens ?? 0) * pricing.read +
      (input.cacheWriteInputTokens ?? 0) * writeRate +
      input.outputTokens * pricing.output) /
    1_000_000;
  return {
    amount,
    currency: "USD",
    kind: "api-estimate",
    pricingRevision: "anthropic-api-2026-09-09",
    pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
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
