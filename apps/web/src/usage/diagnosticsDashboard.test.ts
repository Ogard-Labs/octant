import type { TurnMetricsRecord } from "@octant/contracts";
import { buildTurnDiagnosticsReport } from "@octant/domain";
import { describe, expect, it } from "vitest";
import { diagnosticsDashboard } from "./diagnosticsDashboard";

function turn(minute: number, overrides: Record<string, unknown> = {}): TurnMetricsRecord {
  const start = new Date(Date.UTC(2026, 10, 7, 10, minute)).toISOString();
  return {
    threadId: "66000000-0000-4000-8000-0000000000a1",
    mode: "code",
    providerInstanceId: "66000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    stopReason: "end-of-turn",
    usage: { inputTokens: 1_000, outputTokens: 100, costUsd: 0.5 },
    metrics: {
      precision: "exact",
      wallMs: 4_000,
      timeToFirstTokenMs: 800,
      decodeOutputTokens: 100,
      decodeMs: 2_000,
      toolMs: 0,
      modelCalls: 1,
    },
    diagnostics: { toolCalls: 4, toolFailures: 1 },
    startedAt: start,
    endedAt: start,
    ...overrides,
  } as TurnMetricsRecord;
}

const options = {
  generatedAt: "2026-11-07T12:00:00.000Z",
  bucket: "hour",
  timeZone: "UTC",
} as const;

describe("the Diagnostics dashboard", () => {
  it("states each headline's change against the span before, toned by which way is good", () => {
    const now = buildTurnDiagnosticsReport(
      [turn(0), turn(10, { stopReason: "failed" }), turn(70)],
      options,
    );
    const before = buildTurnDiagnosticsReport([turn(0)], options);

    const dashboard = diagnosticsDashboard(now, before, "vs the 7 days before");

    const failed = dashboard.kpis.find((block) => block.label === "Failed turns");
    expect(failed).toMatchObject({ value: 1, delta: 1, goodDirection: "down" });
    expect(failed?.caption).toBe("vs the 7 days before");
    const cost = dashboard.kpis.find((block) => block.label === "Provider-reported cost");
    expect(cost).toMatchObject({ value: 1.5, delta: 1, unit: "USD" });
    expect(dashboard.kpis.find((block) => block.label === "Turns")?.sparkline).toEqual([2, 1]);
    expect(dashboard.turnsOverTime?.series.map((series) => series.seriesId)).toEqual([
      "finished",
      "stopped",
      "failed",
    ]);
    expect(dashboard.turnsOverTime?.series[0]?.points.map((point) => point.x)).toEqual([
      "11-07 10h",
      "11-07 11h",
    ]);
    expect(dashboard.troubledShareOverTime?.series[0]?.points.map((point) => point.y)).toEqual([
      50, 0,
    ]);
  });

  it("leaves out a headline or chart nothing measured, instead of drawing zero", () => {
    const report = buildTurnDiagnosticsReport(
      [
        turn(0, {
          usage: undefined,
          metrics: { precision: "unavailable", wallMs: 1_000 },
          diagnostics: { toolCalls: 0, toolFailures: 0 },
        }),
      ],
      options,
    );

    const dashboard = diagnosticsDashboard(report, undefined, undefined);
    const labels = dashboard.kpis.map((block) => block.label);

    expect(labels).not.toContain("Speed, typical");
    expect(labels).not.toContain("Tool failure rate");
    expect(labels).not.toContain("Provider-reported cost");
    expect(dashboard.kpis.every((block) => block.delta === undefined)).toBe(true);
    expect(dashboard.speedOverTime).toBeUndefined();
    expect(dashboard.speedByModel).toBeUndefined();
    expect(dashboard.toolFailures).toBeUndefined();
  });
});
