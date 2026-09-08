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

/** Read-only Codex rollout usage adapter. It never opens auth/config files. */
export function createCodexLocalUsageHistorySource(
  options: Omit<LocalUsageHistoryReaderOptions, "sourceKind" | "providerKey">,
): ProviderLocalUsageHistorySource {
  return {
    sourceKind: "codex",
    read: (request: LocalUsageHistoryRequest) =>
      Effect.tryPromise({
        try: async () => ({
          ...(await readLocalUsageHistory(
            { ...options, sourceKind: "codex", providerKey: "codex" },
            request,
            createCodexLineParser(),
          )),
        }),
        catch: (): ProviderFailure => ({
          category: "provider-failed",
          message: "Codex local usage history could not be read.",
        }),
      }),
  };
}

function createCodexLineParser(): LocalUsageHistoryLineParser {
  const models = new Map<string, string>();
  return (input) => parseCodexLine(input, models);
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
  if (value?.type !== "event_msg") return undefined;
  const payload = record(value.payload);
  if (payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  const last = record(info?.last_token_usage);
  if (last === undefined) return undefined;
  const inputTokens = nonNegativeInt(last.input_tokens);
  const outputTokens = nonNegativeInt(last.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const observedAt = timestamp(value.timestamp);
  if (observedAt === undefined) return undefined;
  const sourceSessionId =
    text(payload.thread_id) ??
    text(payload.session_id) ??
    sessionIdFromPath(input.sourceSessionIdHint);
  const modelId =
    text(payload.model) ??
    text(info?.model) ??
    text(record(value.turn_context)?.model) ??
    models.get(sourceSessionId) ??
    "unknown";
  const cacheReadInputTokens = nonNegativeInt(last.cached_input_tokens);
  const cacheWriteInputTokens = nonNegativeInt(last.cache_write_input_tokens);
  const reasoningTokens = nonNegativeInt(last.reasoning_output_tokens);
  const costUsd = nonNegativeNumber(last.cost_usd) ?? nonNegativeNumber(info?.cost_usd);
  const cost =
    costUsd === undefined
      ? codexApiEstimate({
          modelId,
          inputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
          outputTokens,
        })
      : {
          amount: costUsd,
          currency: "USD" as const,
          kind: "provider-recorded" as const,
        };
  return {
    sourceKind: "codex",
    sourceInstallationId: input.sourceInstallationId,
    sourceSessionId,
    sourceEventId: stableUsageId("codex", sourceSessionId, observedAt, JSON.stringify(last)),
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

function codexApiEstimate(input: {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly cacheReadInputTokens: number | undefined;
  readonly cacheWriteInputTokens: number | undefined;
  readonly outputTokens: number;
}): LocalUsageHistoryRecord["cost"] {
  const pricing = [
    { prefix: "gpt-5.6-luna", input: 0.2, read: 0.02, write: 0.25, output: 1.2 },
    { prefix: "gpt-5.6-terra", input: 2, read: 0.2, write: 2.5, output: 12 },
    { prefix: "gpt-5.6-sol", input: 4, read: 0.4, write: 5, output: 20 },
  ].find((candidate) => input.modelId.startsWith(candidate.prefix));
  if (pricing === undefined) return undefined;
  if (input.cacheReadInputTokens !== undefined && input.cacheReadInputTokens > input.inputTokens)
    return undefined;
  if ((input.cacheWriteInputTokens ?? 0) > 0) return undefined;
  const uncached = input.inputTokens - (input.cacheReadInputTokens ?? 0);
  const amount =
    (uncached * pricing.input +
      (input.cacheReadInputTokens ?? 0) * pricing.read +
      input.outputTokens * pricing.output) /
    1_000_000;
  return {
    amount,
    currency: "USD",
    kind: "api-estimate",
    pricingRevision: "openai-api-2026-09-09",
    pricingSource: "https://developers.openai.com/api/docs/pricing",
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
