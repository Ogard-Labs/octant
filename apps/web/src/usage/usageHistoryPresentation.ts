export type HistoryMetric = "tokens" | "cost";
export type HistoryCostBasis = "apiEstimateUsd" | "providerRecordedUsd";

export function compactTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
export function dollars(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2,
  }).format(value);
}
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

export function historyProviderName(key: string, fallback = key): string {
  return key === "codex" ? "Codex" : key === "claude-code" ? "Claude Code" : fallback;
}
