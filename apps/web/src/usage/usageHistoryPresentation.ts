import { compactTokenCount } from "../context/contextInspectorModel";
import { providerGlyphColor } from "../providers/ProviderGlyph";

export type HistoryMetric = "tokens" | "cost";
export type HistoryCostBasis = "apiEstimateUsd" | "providerRecordedUsd";

export function compactTokens(value: number): string {
  return compactTokenCount(value);
}
export function dollars(value: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2,
  }).format(value);
}
/** A chart's tick value: whole dollars carry no cents. */
export function axisValue(value: number, metric: HistoryMetric): string {
  return metric === "tokens"
    ? compactTokens(value)
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
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

/** The provider's own colour, for the two histories whose provider is known. */
export function historyProviderColor(key: string): string | undefined {
  if (key === "codex") return providerGlyphColor("codex");
  return key === "claude-code" ? providerGlyphColor("claude") : undefined;
}
