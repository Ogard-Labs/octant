import type { LocalUsageHistoryTokenTotals } from "@octant/contracts";
import { compactTokens } from "./usageHistoryPresentation";

interface TokenPart {
  readonly key: "input" | "cache-read" | "cache-write" | "other-input" | "output";
  readonly label: string;
  readonly value: number | undefined;
  readonly coverage?: { readonly measured: number; readonly total: number };
}

/**
 * Processed tokens by type. Input already includes cache reads and writes, so
 * what no request measured by type is drawn as its own part: never counted
 * twice, never given to a type, and a type nobody measured is not zero.
 */
function tokenParts(totals: LocalUsageHistoryTokenTotals): ReadonlyArray<TokenPart> {
  const input = (
    [
      ["input", "Input", totals.uncachedInputTokens, totals.componentCoverage.uncachedInput],
      ["cache-read", "Cache read", totals.cacheReadInputTokens, totals.componentCoverage.cacheRead],
      [
        "cache-write",
        "Cache write",
        totals.cacheWriteInputTokens,
        totals.componentCoverage.cacheWrite,
      ],
    ] as const
  ).map(([key, label, value, coverage]): TokenPart => ({ key, label, value, coverage }));
  const sum = input.reduce((total, part) => total + (part.value ?? 0), 0);
  // Parts that add up to more than the input they split cannot be drawn.
  const split = sum <= totals.inputTokens;
  const rest = totals.inputTokens - (split ? sum : 0);
  return [
    ...(split ? input : input.map((part): TokenPart => ({ ...part, value: undefined }))),
    ...(rest > 0
      ? [{ key: "other-input", label: "Input not broken down", value: rest } as const]
      : []),
    { key: "output", label: "Output", value: totals.outputTokens },
  ];
}

export function UsageTokenBar(props: { readonly totals: LocalUsageHistoryTokenTotals }) {
  const parts = tokenParts(props.totals);
  const drawn = parts.filter(
    (part): part is TokenPart & { readonly value: number } =>
      part.value !== undefined && part.value > 0,
  );
  const total = drawn.reduce((sum, part) => sum + part.value, 0);
  return (
    <div className="provider-history__tokens">
      {total === 0 ? null : (
        <div
          className="provider-history__token-bar"
          role="img"
          aria-label={`Tokens by type: ${drawn
            .map((part) => `${part.label} ${compactTokens(part.value)}`)
            .join(", ")}`}
        >
          {drawn.map((part) => (
            <span data-token={part.key} key={part.key} style={{ flexGrow: part.value / total }} />
          ))}
        </div>
      )}
      <ul aria-label="Token types">
        {parts.map((part) => (
          <li key={part.key}>
            <span className="provider-history__token-swatch" data-token={part.key} aria-hidden />
            <span>{part.label}</span>
            <strong>{part.value === undefined ? "Unavailable" : compactTokens(part.value)}</strong>
            {part.value !== undefined &&
            part.coverage !== undefined &&
            part.coverage.measured < part.coverage.total ? (
              <small>
                {part.coverage.measured.toLocaleString("en")} of{" "}
                {part.coverage.total.toLocaleString("en")} requests measured
              </small>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
