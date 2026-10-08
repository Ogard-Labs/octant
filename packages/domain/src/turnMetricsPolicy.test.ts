import type { ProviderRuntimeEvent, TurnMetrics, TurnUsage } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  accumulateTurnUsage,
  addTurnToSessionMetrics,
  addTurnUsage,
  cacheHitRate,
  deriveTurnMetrics,
  tokensPerSecond,
} from "./turnMetricsPolicy";

/** Seconds after a fixed epoch, so a scripted turn reads as a timeline. */
const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 9, 6, 12, 0, 0) + seconds * 1000).toISOString();

let sequence = 0;
function event(kind: ProviderRuntimeEvent["kind"], seconds: number, fields: object = {}) {
  sequence += 1;
  return {
    kind,
    instanceId: "provider-a",
    sessionId: "session-a",
    sequence,
    correlationId: "correlation-a",
    occurredAt: at(seconds),
    ...fields,
  } as unknown as ProviderRuntimeEvent;
}

const text = (seconds: number) => event("text-delta", seconds, { text: "x" });
const reasoning = (seconds: number) => event("reasoning-delta", seconds, { text: "x" });
const usage = (seconds: number, fields: object) =>
  event("usage", seconds, { inputTokens: 100, outputTokens: 0, ...fields });
const completed = (seconds: number) => event("completed", seconds);

describe("a harness turn that reports usage for each model request", () => {
  // Request 1: sent at 0s, first token at 1s, done at 5s (4s decode, 80 tokens).
  // The tool then runs for 10s. Request 2: sent at 15s, first token at 17s,
  // done at 19s (2s decode, 60 tokens).
  const events = [
    reasoning(1),
    text(1.5),
    usage(5, { outputTokens: 80, requestStartedAt: at(0) }),
    event("tool-request", 5, { requestId: "call-1", toolName: "read", inputJson: "{}" }),
    text(17),
    usage(19, { outputTokens: 60, requestStartedAt: at(15) }),
    // The loop restates the whole turn once before it ends.
    usage(19, { inputTokens: 200, outputTokens: 140 }),
    completed(19),
  ];

  it("is exact and leaves the tool time out of the decode window", () => {
    const { metrics } = deriveTurnMetrics({ startedAt: at(0), endedAt: at(19), events });

    expect(metrics).toEqual({
      precision: "exact",
      wallMs: 19_000,
      timeToFirstTokenMs: 1_000,
      decodeOutputTokens: 140,
      decodeMs: 6_000,
      toolMs: 10_000,
      modelCalls: 2,
    });
    expect(tokensPerSecond(metrics)).toBeCloseTo(23.33, 2);
  });

  it("counts every request's tokens once, not the restated total on top", () => {
    const { usage: turnUsage } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(19),
      events,
    });

    expect(turnUsage).toEqual({ inputTokens: 200, outputTokens: 140 });
  });

  it("counts the wait for a retried request as first-token time, not decode time", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(9),
      events: [
        event("retrying", 2, {
          attempt: 2,
          maxAttempts: 4,
          delayMs: 3_000,
          reason: "unavailable",
        }),
        text(6),
        usage(8, { outputTokens: 40, requestStartedAt: at(0) }),
        completed(8),
      ],
    });

    expect(metrics.timeToFirstTokenMs).toBe(6_000);
    expect(metrics.retries).toBe(1);
    expect(metrics.decodeMs).toBe(2_000);
  });

  it("measures what streamed and skips a request that only called tools", () => {
    const { metrics, usage: turnUsage } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(14),
      events: [
        usage(3, { outputTokens: 30, requestStartedAt: at(0) }),
        event("tool-request", 3, { requestId: "call-1", toolName: "read", inputJson: "{}" }),
        text(10),
        usage(12, { outputTokens: 20, requestStartedAt: at(8) }),
        completed(12),
      ],
    });

    expect(metrics).toMatchObject({
      precision: "exact",
      decodeOutputTokens: 20,
      decodeMs: 2_000,
      modelCalls: 1,
      toolMs: 5_000,
    });
    expect(turnUsage?.outputTokens).toBe(50);
  });
});

describe("a Codex-style turn that reports one usage for the whole turn", () => {
  const events = [
    text(2),
    event("tool-start", 4, { toolCallId: "t1", toolName: "shell" }),
    event("tool-success", 9, { toolCallId: "t1", summary: "ok" }),
    event("tool-start", 10, { toolCallId: "t2", toolName: "shell" }),
    event("tool-failure", 12, { toolCallId: "t2", message: "no" }),
    text(14),
    usage(16, { inputTokens: 500, outputTokens: 120, cacheReadInputTokens: 400 }),
    completed(16),
  ];

  it("is approximate and subtracts the tool spans it was told about", () => {
    const { metrics } = deriveTurnMetrics({ startedAt: at(0), endedAt: at(16), events });

    expect(metrics).toEqual({
      precision: "approximate",
      wallMs: 16_000,
      timeToFirstTokenMs: 2_000,
      decodeOutputTokens: 120,
      // 2s to 16s is 14s; 5s and 2s of it were tool calls.
      decodeMs: 7_000,
      toolMs: 7_000,
      modelCalls: 1,
    });
  });

  it("merges tool calls that overlap instead of counting their time twice", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(10),
      events: [
        text(1),
        event("tool-start", 2, { toolCallId: "a", toolName: "shell" }),
        event("tool-start", 3, { toolCallId: "b", toolName: "shell" }),
        event("tool-success", 6, { toolCallId: "a", summary: "ok" }),
        event("tool-success", 7, { toolCallId: "b", summary: "ok" }),
        usage(10, { outputTokens: 50 }),
        completed(10),
      ],
    });

    expect(metrics.toolMs).toBe(5_000);
    expect(metrics.decodeMs).toBe(4_000);
  });

  it("takes a person's approval wait out of the window", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(30),
      events: [
        text(1),
        event("approval-request", 3, {
          requestId: "approval-1",
          action: "shell",
          description: "run it",
        }),
        text(23),
        usage(25, { outputTokens: 60 }),
        completed(25),
      ],
    });

    expect(metrics.precision).toBe("approximate");
    expect(metrics.toolMs).toBe(20_000);
    expect(metrics.decodeMs).toBe(4_000);
  });

  it("keeps the last report when the provider restates the turn's usage", () => {
    const { usage: turnUsage } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(8),
      events: [
        text(1),
        usage(3, { inputTokens: 100, outputTokens: 10 }),
        usage(8, { inputTokens: 250, outputTokens: 90, reasoningTokens: 5 }),
        completed(8),
      ],
    });

    expect(turnUsage).toEqual({ inputTokens: 250, outputTokens: 90, reasoningTokens: 5 });
  });

  it("is exact when the turn ran no tool at all", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(6),
      events: [reasoning(1), text(2), usage(6, { outputTokens: 80 }), completed(6)],
    });

    expect(metrics).toMatchObject({
      precision: "exact",
      timeToFirstTokenMs: 1_000,
      decodeMs: 5_000,
      toolMs: 0,
      modelCalls: 1,
    });
  });
});

describe("a provider that reports nothing it can be timed against", () => {
  it("is unavailable when an ACP provider streams text but reports no usage", () => {
    const { metrics, usage: turnUsage } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(5),
      events: [text(1), text(2), completed(5)],
    });

    expect(metrics).toEqual({ precision: "unavailable", wallMs: 5_000 });
    expect(turnUsage).toBeUndefined();
  });

  it("is unavailable when usage arrives but nothing streamed", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(5),
      events: [usage(5, { outputTokens: 40 }), completed(5)],
    });

    expect(metrics.precision).toBe("unavailable");
  });

  it("is unavailable when the provider reported zero output tokens", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(5),
      events: [text(1), usage(5, { outputTokens: 0 }), completed(5)],
    });

    expect(metrics.precision).toBe("unavailable");
  });

  it("is unavailable when tool time leaves no model time to divide by", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(10),
      events: [
        text(2),
        event("tool-start", 2, { toolCallId: "t", toolName: "shell" }),
        event("tool-success", 10, { toolCallId: "t", summary: "ok" }),
        usage(10, { outputTokens: 30 }),
        completed(10),
      ],
    });

    expect(metrics.precision).toBe("unavailable");
  });

  it("still reports a failed turn's timing when it got as far as streaming", () => {
    const { metrics } = deriveTurnMetrics({
      startedAt: at(0),
      endedAt: at(6),
      events: [text(1), usage(5, { outputTokens: 20 }), event("failed", 6, { failure: {} })],
    });

    expect(metrics).toMatchObject({ precision: "exact", decodeMs: 4_000 });
  });
});

describe("timing over a whole session", () => {
  const exact: TurnMetrics = {
    precision: "exact",
    wallMs: 10_000,
    timeToFirstTokenMs: 1_000,
    decodeOutputTokens: 100,
    decodeMs: 2_000,
    toolMs: 0,
    modelCalls: 1,
  };
  const approximate: TurnMetrics = {
    precision: "approximate",
    wallMs: 30_000,
    timeToFirstTokenMs: 3_000,
    decodeOutputTokens: 100,
    decodeMs: 8_000,
    toolMs: 12_000,
    modelCalls: 1,
  };

  it("weights speed by decode time instead of averaging the turns' ratios", () => {
    const total = [exact, approximate].reduce<
      ReturnType<typeof addTurnToSessionMetrics> | undefined
    >((sum, turn) => addTurnToSessionMetrics(sum, turn), undefined);

    // 200 tokens over 10s, not the mean of 50 and 12.5.
    expect(tokensPerSecond(total!)).toBe(20);
    expect(total).toMatchObject({
      turns: 2,
      measuredTurns: 2,
      precision: "approximate",
      timeToFirstTokenTotalMs: 4_000,
    });
  });

  it("counts an unavailable turn without letting it weaken the figure", () => {
    const afterExact = addTurnToSessionMetrics(undefined, exact);
    const total = addTurnToSessionMetrics(afterExact, { precision: "unavailable", wallMs: 4_000 });

    expect(total).toMatchObject({ turns: 2, measuredTurns: 1, precision: "exact" });
  });

  it("stays unavailable until some turn could be measured", () => {
    const total = addTurnToSessionMetrics(undefined, { precision: "unavailable", wallMs: 1 });

    expect(total.precision).toBe("unavailable");
    expect(tokensPerSecond(total)).toBeUndefined();
  });

  it("gives the same totals however the turns are ordered, as a replay needs", () => {
    const forward = [exact, approximate, exact].reduce<
      ReturnType<typeof addTurnToSessionMetrics> | undefined
    >((sum, turn) => addTurnToSessionMetrics(sum, turn), undefined);
    const backward = [exact, approximate, exact]
      .reverse()
      .reduce<ReturnType<typeof addTurnToSessionMetrics> | undefined>(
        (sum, turn) => addTurnToSessionMetrics(sum, turn),
        undefined,
      );

    expect(backward).toEqual(forward);
  });
});

describe("cache hit rate", () => {
  it("is the cache read share of all input, never rounded up to a full hit", () => {
    expect(
      cacheHitRate({ inputTokens: 200_000, outputTokens: 1, cacheReadInputTokens: 199_999 }),
    ).toBeCloseTo(0.999995, 6);
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 100 })).toBe(1);
  });

  it("is hidden when the provider reported no cache figure or sent nothing", () => {
    expect(cacheHitRate({ inputTokens: 100, outputTokens: 1 })).toBeUndefined();
    expect(
      cacheHitRate({ inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0 }),
    ).toBeUndefined();
    expect(cacheHitRate(undefined)).toBeUndefined();
  });

  it("is hidden when the read exceeds the input it should be part of", () => {
    expect(
      cacheHitRate({ inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 30 }),
    ).toBeUndefined();
  });
});

describe("usage totals", () => {
  const first: TurnUsage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 60 };
  const second: TurnUsage = { inputTokens: 50, outputTokens: 5, reasoningTokens: 2, costUsd: 0.5 };

  it("sums a figure only once some turn reported it", () => {
    expect(addTurnUsage(addTurnUsage(undefined, first), second)).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      cacheReadInputTokens: 60,
      reasoningTokens: 2,
      costUsd: 0.5,
    });
  });
});

describe("a turn's usage for the ledger", () => {
  const request = (seconds: number, fields: object) =>
    usage(seconds, { requestStartedAt: at(seconds - 1), ...fields }) as Extract<
      ProviderRuntimeEvent,
      { kind: "usage" }
    >;
  const whole = (seconds: number, fields: object) =>
    usage(seconds, fields) as Extract<ProviderRuntimeEvent, { kind: "usage" }>;
  const fold = (reports: ReadonlyArray<Extract<ProviderRuntimeEvent, { kind: "usage" }>>) =>
    reports.reduce<TurnUsage | undefined>(accumulateTurnUsage, undefined);

  it("adds up the requests of a turn that never reported its whole", () => {
    expect(
      fold([
        request(2, { inputTokens: 100, outputTokens: 4, costUsd: 0.01 }),
        request(5, { inputTokens: 180, outputTokens: 8, costUsd: 0.02 }),
      ]),
    ).toEqual({ inputTokens: 280, outputTokens: 12, costUsd: 0.03 });
  });

  it("lets a report for the whole turn replace the requests before it", () => {
    expect(
      fold([
        request(2, { inputTokens: 100, outputTokens: 4 }),
        whole(6, { inputTokens: 300, outputTokens: 20, costUsd: 0.05 }),
      ]),
    ).toEqual({ inputTokens: 300, outputTokens: 20, costUsd: 0.05 });
  });

  it("has no cost once any request in the sum reported none", () => {
    expect(
      fold([
        request(2, { inputTokens: 100, outputTokens: 4, costUsd: 0.01 }),
        request(5, { inputTokens: 180, outputTokens: 8 }),
        request(7, { inputTokens: 200, outputTokens: 2, costUsd: 0.01 }),
      ]),
    ).toEqual({ inputTokens: 480, outputTokens: 14 });
  });
});
