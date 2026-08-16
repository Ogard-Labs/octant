import type { UsageRecord } from "@octant/contracts";

/**
 * Safe usage record fields for export. Only reference ids, token counts,
 * quality, request shape, attribution categories, and timestamps. Never
 * includes raw prompts, file contents, credentials, provider headers, or
 * account identifiers.
 */
export interface SafeUsageExportRow {
  readonly reconciliationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly requestShape: string;
  readonly quality: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly providerExecutionDurationMs?: number;
  readonly plannedInputTokens: number;
  readonly varianceTokens: number;
  readonly observedAt: string;
  readonly attributionCategories: string;
}

export function toSafeExportRow(record: UsageRecord): SafeUsageExportRow {
  return {
    reconciliationId: record.reconciliationId,
    subjectType: record.subject.aggregateType,
    subjectId: record.subject.aggregateId,
    providerInstanceId: record.providerInstanceId,
    modelId: record.modelId,
    requestShape: record.requestShape,
    quality: record.quality,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    ...(record.reasoningTokens === undefined ? {} : { reasoningTokens: record.reasoningTokens }),
    ...(record.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: record.cacheReadInputTokens }),
    ...(record.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: record.cacheWriteInputTokens }),
    ...(record.providerExecutionDurationMs === undefined
      ? {}
      : { providerExecutionDurationMs: record.providerExecutionDurationMs }),
    plannedInputTokens: record.plannedInputTokens,
    varianceTokens: record.varianceTokens,
    observedAt: record.observedAt,
    attributionCategories: record.attribution.map((entry) => entry.category).join(";"),
  };
}

const CSV_COLUMNS: ReadonlyArray<keyof SafeUsageExportRow> = [
  "reconciliationId",
  "subjectType",
  "subjectId",
  "providerInstanceId",
  "modelId",
  "requestShape",
  "quality",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "providerExecutionDurationMs",
  "plannedInputTokens",
  "varianceTokens",
  "observedAt",
  "attributionCategories",
];

function csvEscape(value: string | number | undefined): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function recordsToCsv(records: ReadonlyArray<UsageRecord>): string {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((record) => {
    const row = toSafeExportRow(record);
    return CSV_COLUMNS.map((column) => csvEscape(row[column])).join(",");
  });
  return [header, ...rows].join("\n");
}

export function recordsToJson(records: ReadonlyArray<UsageRecord>): string {
  return JSON.stringify(records.map(toSafeExportRow), null, 2);
}

export const SENSITIVE_EXPORT_FIELDS = [
  "promptBody",
  "fileContents",
  "credentials",
  "providerHeaders",
  "accountId",
] as const;
