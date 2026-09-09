import { Effect } from "effect";
import type {
  LocalUsageHistoryRecord,
  LocalUsageHistoryRequest,
  ProviderFailure,
  UtcTimestamp,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { resolveLocalUsageCost, type PricingUsageRecord } from "./localUsagePricing";

interface CodexUsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

interface CodexParserState {
  readonly models: Map<string, string>;
  readonly cumulative: Map<string, CodexUsageSnapshot>;
}

const parserCaches = new Map<string, CodexParserState>();
const MAX_PARSER_CACHES = 32;
const MAX_PARSER_SESSIONS = 4096;
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
  let state = parserCaches.get(options.root);
  if (state === undefined) {
    if (parserCaches.size >= MAX_PARSER_CACHES) {
      const oldest = parserCaches.keys().next().value;
      if (oldest !== undefined) parserCaches.delete(oldest);
    }
    state = {
      models: new Map<string, string>(),
      cumulative: new Map<string, CodexUsageSnapshot>(),
    };
    parserCaches.set(options.root, state);
  }
  return {
    sourceKind: "codex",
    read: (request: LocalUsageHistoryRequest) => {
      let operationSignal: AbortSignal | undefined;
      return Effect.tryPromise({
        try: async (effectSignal) => {
          operationSignal = effectSignal;
          return {
            ...(await readLocalUsageHistory(
              {
                ...options,
                sourceKind: "codex",
                providerKey: "codex",
                onSourceInvalidated: () => {
                  options.onSourceInvalidated?.();
                  state.models.clear();
                  state.cumulative.clear();
                },
              },
              request,
              createCodexLineParser(state),
              effectSignal,
            )),
          };
        },
        catch: (): ProviderFailure => {
          if (operationSignal?.aborted) {
            state.models.clear();
            state.cumulative.clear();
          }
          return {
            category: "provider-failed",
            message: "Codex local usage history could not be read.",
          };
        },
      });
    },
  };
}

function createCodexLineParser(state: CodexParserState): LocalUsageHistoryLineParser {
  const seenUsageIds = new Set<string>();
  return (input) => parseCodexLine(input, state, seenUsageIds);
}

function parseCodexLine(
  input: {
    readonly line: string;
    readonly sourceInstallationId: string;
    readonly sourceSessionIdHint: string;
    readonly relativePath: string;
    readonly lineNumber: number;
  },
  state: CodexParserState,
  seenUsageIds: Set<string>,
): LocalUsageHistoryRecord | undefined {
  const value = parseRecord(input.line);
  if (value?.type === "session_meta") {
    const payload = record(value.payload);
    const sessionId = text(payload?.id) ?? sessionIdFromPath(input.sourceSessionIdHint);
    const provenance = record(record(payload?.base_instructions)?.provenance);
    const model = text(payload?.model) ?? text(provenance?.model);
    if (model !== undefined) setBounded(state.models, sessionId, model);
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
    if (model !== undefined) setBounded(state.models, sessionId, model);
    return undefined;
  }
  if (value?.type !== "event_msg") return undefined;
  const payload = record(value.payload);
  if (payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  const lastValue = record(info?.last_token_usage);
  const last = usageSnapshot(lastValue);
  if (last === undefined) return undefined;
  const sourceSessionId =
    text(payload.thread_id) ??
    text(payload.threadId) ??
    text(payload.session_id) ??
    text(payload.sessionId) ??
    sessionIdFromPath(input.sourceSessionIdHint);
  const modelId =
    text(payload.model) ?? text(info?.model) ?? state.models.get(sourceSessionId) ?? "unknown";
  const cumulativeValue = record(info?.total_token_usage);
  const cumulative = usageSnapshot(cumulativeValue);
  let usage = last;
  if (cumulative !== undefined) {
    const previous = state.cumulative.get(sourceSessionId);
    if (previous !== undefined) {
      const delta = subtractUsage(cumulative, previous);
      if (delta === undefined) {
        setBounded(state.cumulative, sourceSessionId, cumulative);
        return undefined;
      }
      if (delta === "unchanged") return undefined;
      usage = delta;
    }
    setBounded(state.cumulative, sourceSessionId, cumulative);
  }
  const observedAt = timestamp(value.timestamp);
  if (observedAt === undefined) return undefined;
  const costUsd = nonNegativeNumber(lastValue?.cost_usd) ?? nonNegativeNumber(info?.cost_usd);
  const pricingRecord: PricingUsageRecord = {
    modelId,
    inputTokens: usage.inputTokens,
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    outputTokens: usage.outputTokens,
    ...(costUsd === undefined
      ? {}
      : {
          cost: { amount: costUsd, currency: "USD" as const, kind: "provider-recorded" as const },
        }),
  };
  const cost = localCost("openai", pricingRecord);
  const turnIdentity =
    text(payload.turn_id) ?? text(payload.turnId) ?? text(info?.turn_id) ?? text(info?.turnId);
  const eventIdentity =
    cumulative === undefined
      ? (turnIdentity ?? `${JSON.stringify(lastValue)}\0${observedAt}\0${input.lineNumber}`)
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
    inputTokens: usage.inputTokens,
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(cost === undefined ? {} : { cost }),
  };
}

function usageSnapshot(value: Record<string, unknown> | undefined): CodexUsageSnapshot | undefined {
  if (value === undefined) return undefined;
  const inputTokens = nonNegativeInt(value.input_tokens) ?? nonNegativeInt(value.inputTokens);
  const outputTokens = nonNegativeInt(value.output_tokens) ?? nonNegativeInt(value.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheReadInputTokens =
    nonNegativeInt(value.cached_input_tokens) ?? nonNegativeInt(value.cachedInputTokens);
  const cacheWriteInputTokens =
    nonNegativeInt(value.cache_write_input_tokens) ?? nonNegativeInt(value.cacheWriteInputTokens);
  const reasoningTokens =
    nonNegativeInt(value.reasoning_output_tokens) ?? nonNegativeInt(value.reasoningOutputTokens);
  const totalTokens = nonNegativeInt(value.total_tokens) ?? nonNegativeInt(value.totalTokens);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

type UsageDelta = CodexUsageSnapshot | "unchanged";

function subtractUsage(
  current: CodexUsageSnapshot,
  previous: CodexUsageSnapshot,
): UsageDelta | undefined {
  const inputTokens = current.inputTokens - previous.inputTokens;
  const outputTokens = current.outputTokens - previous.outputTokens;
  if (inputTokens < 0 || outputTokens < 0) return undefined;
  const cacheReadInputTokens = subtractOptional(
    current.cacheReadInputTokens,
    previous.cacheReadInputTokens,
  );
  const cacheWriteInputTokens = subtractOptional(
    current.cacheWriteInputTokens,
    previous.cacheWriteInputTokens,
  );
  const reasoningTokens = subtractOptional(current.reasoningTokens, previous.reasoningTokens);
  if (
    cacheReadInputTokens === undefined ||
    cacheWriteInputTokens === undefined ||
    reasoningTokens === undefined
  )
    return undefined;
  const cacheReadValue = cacheReadInputTokens ?? 0;
  const cacheWriteValue = cacheWriteInputTokens ?? 0;
  const reasoningValue = reasoningTokens ?? 0;
  const changed =
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheReadValue > 0 ||
    cacheWriteValue > 0 ||
    reasoningValue > 0;
  if (!changed) return "unchanged";
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens === null ? {} : { cacheReadInputTokens: cacheReadInputTokens }),
    ...(cacheWriteInputTokens === null ? {} : { cacheWriteInputTokens: cacheWriteInputTokens }),
    ...(reasoningTokens === null ? {} : { reasoningTokens: reasoningTokens }),
  };
}

function subtractOptional(
  current: number | undefined,
  previous: number | undefined,
): number | null | undefined {
  if (current === undefined) return null;
  if (previous === undefined) return current;
  const delta = current - previous;
  return delta < 0 ? undefined : delta;
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
          cacheSavingsUsd: resolved.estimate.cacheSavingsUsd,
        }
      : {}),
  };
}

function setBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_PARSER_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
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
