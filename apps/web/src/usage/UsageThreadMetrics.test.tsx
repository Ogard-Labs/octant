import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  decodeTurnMetricsRecord,
  decodeTurnMetricsSummary,
  decodeUsageQueryResponse,
  type TurnMetricsSummary,
} from "@octant/contracts";
import { threadStats, threadStatsInputOf, turnDetail } from "@octant/domain";
import type { UsageClient } from "@octant/client-runtime/usage-client";
import { UsageDashboard } from "./UsageDashboard";
import { UsageThreadMetrics } from "./UsageThreadMetrics";
import { UsageWorkspace } from "./UsageWorkspace";

const THREAD = "0b6f7ac4-4d7e-4d07-8f35-2f64d7a2e3a1";
const PROVIDER = "66000000-0000-4000-8000-000000000001";

function composerFixture(): TurnMetricsSummary {
  const turn = decodeTurnMetricsRecord({
    threadId: THREAD,
    mode: "code",
    providerInstanceId: PROVIDER,
    modelId: "gpt-5.6-luna",
    stopReason: "end-of-turn",
    usage: { inputTokens: 100_000, cacheReadInputTokens: 99_500, outputTokens: 10_000 },
    metrics: {
      precision: "approximate",
      wallMs: 12_000,
      timeToFirstTokenMs: 900,
      decodeOutputTokens: 410,
      decodeMs: 10_000,
      toolMs: 1_000,
      modelCalls: 1,
    },
    startedAt: "2026-10-06T10:00:00.000Z",
    endedAt: "2026-10-06T10:00:12.000Z",
  });
  return decodeTurnMetricsSummary({
    turns: [turn],
    turnCount: 1,
    usage: turn.usage,
    metrics: {
      turns: 1,
      measuredTurns: 1,
      precision: "approximate",
      decodeOutputTokens: 410,
      decodeMs: 10_000,
      toolMs: 1_000,
      timeToFirstTokenTotalMs: 900,
    },
  });
}

function queryResponse(turnMetrics: TurnMetricsSummary) {
  return decodeUsageQueryResponse({
    records: [],
    totals: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      exactCount: 0,
      estimatedCount: 0,
      reconciledCount: 0,
      staleCount: 0,
      unavailableCount: 0,
    },
    byProvider: [],
    byCategory: [],
    byDay: [],
    byWeek: [],
    cumulative: [],
    topConsumers: [],
    hasMore: false,
    queryAt: "2026-10-06T12:00:00.000Z",
    turnMetrics,
  });
}

function statText(summary: TurnMetricsSummary, key: string): string {
  const text = threadStats(threadStatsInputOf(summary)).find((stat) => stat.key === key)?.text;
  if (text === undefined) throw new Error(`composer fixture has no ${key} figure`);
  return text;
}

describe("usage thread rows", () => {
  it("shows the same cache, speed, first token, and cost as the composer for the same thread", async () => {
    const summary = composerFixture();
    const client: UsageClient = {
      query: vi.fn(async () => queryResponse(summary)),
      export: vi.fn(),
      reset: vi.fn(),
      retain: vi.fn(),
    };
    render(<UsageDashboard client={client} />);

    const table = await screen.findByRole("table", { name: "Usage by thread" });
    expect(within(table).getByText(statText(summary, "cache"))).toBeInTheDocument();
    expect(within(table).getByText(statText(summary, "speed"))).toBeInTheDocument();
    expect(within(table).getByText(statText(summary, "first-token"))).toBeInTheDocument();
    expect(within(table).getByText(statText(summary, "cost"))).toBeInTheDocument();
    expect(statText(summary, "cache")).toBe("cache 99.5%");
    expect(statText(summary, "speed").startsWith("~")).toBe(true);
    expect(statText(summary, "cost")).toContain("est.");
    expect(within(table).queryByText("100%")).not.toBeInTheDocument();
  });

  it("hides cache, speed, and first token when the reading cannot state them", () => {
    const summary = decodeTurnMetricsSummary({
      turns: [
        decodeTurnMetricsRecord({
          threadId: THREAD,
          mode: "chat",
          providerInstanceId: PROVIDER,
          modelId: "gpt-5.6-luna",
          stopReason: "end-of-turn",
          usage: { inputTokens: 100, outputTokens: 20 },
          metrics: { precision: "unavailable", wallMs: 1_000 },
          startedAt: "2026-10-06T10:00:00.000Z",
          endedAt: "2026-10-06T10:00:01.000Z",
        }),
      ],
      turnCount: 1,
      usage: { inputTokens: 100, outputTokens: 20 },
      metrics: {
        turns: 1,
        measuredTurns: 0,
        precision: "unavailable",
        decodeOutputTokens: 0,
        decodeMs: 0,
        toolMs: 0,
        timeToFirstTokenTotalMs: 0,
      },
    });
    render(<UsageThreadMetrics summary={summary} />);
    const table = screen.getByRole("table", { name: "Usage by thread" });
    expect(within(table).queryByRole("columnheader", { name: "Cache" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Speed" })).not.toBeInTheDocument();
    expect(
      within(table).queryByRole("columnheader", { name: "First token" }),
    ).not.toBeInTheDocument();
    expect(within(table).getByText("↑ 100 in")).toBeInTheDocument();
  });

  it("words the turn drill-in the same way as the composer's turn detail", () => {
    const summary = composerFixture();
    const turn = summary.turns[0];
    if (turn === undefined) throw new Error("fixture has a turn");
    render(<UsageThreadMetrics scopedToThread summary={summary} />);
    fireEvent.click(screen.getByRole("button", { name: "Show turns" }));
    const drill = screen.getByRole("region", { name: "Turn on gpt-5.6-luna" });
    const detail = turnDetail(turn);
    const cache = detail.tokens.find((row) => row.key === "cache-hit");
    const speed = detail.timing.find((row) => row.key === "speed");
    expect(cache?.value).toBe("99.5%");
    expect(within(drill).getByText(cache?.value ?? "")).toBeInTheDocument();
    expect(within(drill).getByText(speed?.value ?? "", { exact: false })).toBeInTheDocument();
    expect(within(drill).getByText(detail.cost?.value ?? "", { exact: false })).toBeInTheDocument();
    expect(within(drill).queryByText("100%")).not.toBeInTheDocument();
  });

  it("reads thread figures from the usage query on the usage page", async () => {
    const summary = composerFixture();
    const query = vi.fn(async () => queryResponse(summary));
    render(<UsageWorkspace client={undefined} usageQuery={{ query }} />);
    const table = await screen.findByRole("table", { name: "Usage by thread" });
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(within(table).getByText(statText(summary, "cache"))).toBeInTheDocument();
    expect(within(table).getByText(statText(summary, "speed"))).toBeInTheDocument();
  });
});
