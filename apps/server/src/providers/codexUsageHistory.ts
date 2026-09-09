import { Effect } from "effect";
import type {
  LocalUsageHistoryRecord,
  LocalUsageHistoryRequest,
  ProviderFailure,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { resolveLocalUsageCost, type PricingUsageRecord } from "./localUsagePricing";

const modelCaches = new Map<string, Map<string, string>>();
import {
  readLocalUsageHistory,
  stableUsageId,
  type LocalUsageHistoryLineParser,
  type LocalUsageHistoryReaderOptions,
} from "./localUsageHistoryReader";

/** Read-only Codex rollout usage adapter. It never opens auth/config files. */
export function createCodexLocalUsageHistorySource(
  options: Omit<LocalUsageHistoryReaderOptions, "sourceKind" | "providerKey">,
): ProviderLocalUsageHistorySource {
  const models = modelCaches.get(options.root) ?? new Map<string, string>();
  modelCaches.set(options.root, models);
  return {
    sourceKind: "codex",
    read: (request: LocalUsageHistoryRequest, signal) =>
      Effect.tryPromise({
        try: async (effectSignal) => ({
          ...(await readLocalUsageHistory(
            { ...options, sourceKind: "codex", providerKey: "codex" },
            request,
            createCodexLineParser(models),
            signal ?? effectSignal,
          )),
        }),
        catch: (): ProviderFailure => ({
          category: "provider-failed",
          message: "Codex local usage history could not be read.",
        }),
      }),
  };
}

function createCodexLineParser(models: Map<string, string>): LocalUsageHistoryLineParser {
  const seenUsageIds = new Set<string>();
  return (input) => parseCodexLine(input, models, seenUsageIds);
}

function parseCodexLine(
  input: {
    readonly line: string;
    readonly sourceInstallationId: string;
    readonly sourceSessionIdHint: string;
    readonly relativePath: string;
    readonly lineNumber: number;
  },
  models: Map<string, string>,
  seenUsageIds: Set<string>,
): LocalUsageHistoryRecord | undefined {
  const value = parseRecord(input.line);
  if (value?.type === "session_meta") {
    const payload = record(value.payload);
    const sessionId = text(payload?.id) ?? sessionIdFromPath(input.sourceSessionIdHint);
    const provenance = record(record(payload?.base_instructions)?.provenance);
    const model = text(payload?.model) ?? text(provenance?.model);
    if (model !== undefined) models.set(sessionId, model);
    return undefined;
  }
  if (value?.type === "turn_context") {
    const payload = record(value.payload);
    const sessionId =
      text(payload?.thread_id) ??
      text(payload?.threadId) ??
      text(payload?.session_id) ??
      text(payload?.sessionId) ??
      sessionIdFromPath(input.sourceSessionIdHint);
    const model = text(payload?.model);
    if (model !== undefined) models.set(sessionId, model);
    return undefined;
  }
  if (value?.type !== "event_msg") return undefined;
  const payload = record(value.payload);
  if (payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  const last = record(info?.last_token_usage);
  if (last === undefined) return undefined;
  const inputTokens = nonNegativeInt(last.input_tokens) ?? nonNegativeInt(last.inputTokens);
  const outputTokens = nonNegativeInt(last.output_tokens) ?? nonNegativeInt(last.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const observedAt = timestamp(value.timestamp);
  if (observedAt === undefined) return undefined;
  const sourceSessionId =
    text(payload.thread_id) ??
    text(payload.threadId) ??
    text(payload.session_id) ??
    text(payload.sessionId) ??
    sessionIdFromPath(input.sourceSessionIdHint);
  const modelId =
    text(payload.model) ?? text(info?.model) ?? models.get(sourceSessionId) ?? "unknown";
  const cacheReadInputTokens =
    nonNegativeInt(last.cached_input_tokens) ?? nonNegativeInt(last.cachedInputTokens);
  const cacheWriteInputTokens =
    nonNegativeInt(last.cache_write_input_tokens) ?? nonNegativeInt(last.cacheWriteInputTokens);
  const reasoningTokens =
    nonNegativeInt(last.reasoning_output_tokens) ?? nonNegativeInt(last.reasoningOutputTokens);
  const costUsd = nonNegativeNumber(last.cost_usd) ?? nonNegativeNumber(info?.cost_usd);
  const pricingRecord: PricingUsageRecord = {
    modelId,
    inputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    outputTokens,
    ...(costUsd === undefined
      ? {}
      : {
          cost: { amount: costUsd, currency: "USD" as const, kind: "provider-recorded" as const },
        }),
  };
  const cost = localCost("openai", pricingRecord);
  const cumulative = record(info?.total_token_usage);
  const turnIdentity =
    text(payload.turn_id) ?? text(payload.turnId) ?? text(info?.turn_id) ?? text(info?.turnId);
  const eventIdentity =
    cumulative === undefined
      ? (turnIdentity ?? JSON.stringify(last))
      : `${turnIdentity ?? ""}\0${JSON.stringify(cumulative)}`;
  const sourceEventId = stableUsageId("codex", sourceSessionId, eventIdentity);
  if (seenUsageIds.has(sourceEventId)) return undefined;
  seenUsageIds.add(sourceEventId);
  return {
    sourceKind: "codex",
    sourceInstallationId: input.sourceInstallationId,
    sourceSessionId,
    sourceEventId,
    providerKey: "codex",
    modelId,
    observedAt,
    inputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function localCost(
  provider: "openai",
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
    ? value.trim().slice(0, 255)
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
  const match = value.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  return match?.[1] ?? value.slice(0, 512);
}
