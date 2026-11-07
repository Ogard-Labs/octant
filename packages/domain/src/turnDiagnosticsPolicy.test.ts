import { decodeTurnDiagnostics, type ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { deriveTurnMetrics } from "./turnMetricsPolicy";

const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 10, 7, 12, 0, 0) + seconds * 1000).toISOString();

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

const start = (seconds: number, toolCallId: string, toolName: string) =>
  event("tool-start", seconds, { toolCallId, toolName });
const success = (seconds: number, toolCallId: string, fields: object = {}) =>
  event("tool-success", seconds, { toolCallId, summary: "done", ...fields });
const failure = (seconds: number, toolCallId: string, fields: object = {}) =>
  event("tool-failure", seconds, { toolCallId, message: "no such file", ...fields });

function diagnose(events: ReadonlyArray<ProviderRuntimeEvent>, endedAt = 60) {
  return deriveTurnMetrics({ startedAt: at(0), endedAt: at(endedAt), events }).diagnostics;
}

describe("turn diagnostics", () => {
  it("states zero tool calls for a turn that ran no tool", () => {
    const diagnostics = diagnose([event("text-delta", 1, { text: "hi" }), event("completed", 2)]);

    expect(diagnostics).toEqual({ toolCalls: 0, toolFailures: 0 });
  });

  it("tallies calls, failures, unfinished calls, exit codes, and durations per tool", () => {
    const diagnostics = diagnose([
      start(1, "a", "Bash"),
      success(3, "a", { exitCode: 0 }),
      start(4, "b", "Bash"),
      failure(9, "b", { exitCode: 2 }),
      start(10, "c", "Read"),
      success(10.5, "c"),
      start(11, "d", "Bash"),
      event("interrupted", 20, { message: "stopped" }),
    ]);

    expect(diagnostics.toolCalls).toBe(4);
    expect(diagnostics.toolFailures).toBe(1);
    expect(diagnostics.tools).toEqual([
      {
        toolName: "Bash",
        calls: 3,
        failed: 1,
        unfinished: 1,
        nonZeroExits: 1,
        totalMs: 7_000,
        maxMs: 5_000,
      },
      { toolName: "Read", calls: 1, failed: 0, unfinished: 0, totalMs: 500, maxMs: 500 },
    ]);
  });

  it("counts a result whose start was never streamed in the totals only", () => {
    const diagnostics = diagnose([failure(2, "orphan"), success(3, "other")]);

    expect(diagnostics).toEqual({ toolCalls: 2, toolFailures: 1 });
  });

  it("does not count a restated start as a second call", () => {
    const diagnostics = diagnose([start(1, "a", "Edit"), start(1.2, "a", "Edit"), success(2, "a")]);

    expect(diagnostics.toolCalls).toBe(1);
  });

  it("groups retries by reason with the time they made the turn wait", () => {
    const retry = (seconds: number, reason: string, delayMs: number) =>
      event("retrying", seconds, { attempt: 2, maxAttempts: 5, delayMs, reason });
    const diagnostics = diagnose([
      retry(1, "rate-limited", 4_000),
      retry(6, "rate-limited", 8_000),
      retry(15, "stream-interrupted", 500),
    ]);

    expect(diagnostics.retries).toEqual([
      { reason: "rate-limited", count: 2, waitMs: 12_000 },
      { reason: "stream-interrupted", count: 1, waitMs: 500 },
    ]);
  });

  it("counts waits on people and rate-limit pressure, and ignores allowed windows", () => {
    const diagnostics = diagnose([
      event("approval-request", 1, { requestId: "r1", action: "run", description: "ls" }),
      event("user-input-request", 2, { requestId: "q1", questions: [] }),
      event("rate-limit-window", 3, { window: "five_hour", status: "allowed" }),
      event("rate-limit-window", 4, { window: "five_hour", status: "warning" }),
      event("rate-limit-bucket", 5, { bucket: "tokens", limit: 100, remaining: 0 }),
      event("context-compacted", 6, { trigger: "automatic" }),
      event("completed", 7, { stopReason: "content-filter" }),
    ]);

    expect(diagnostics).toEqual({
      toolCalls: 0,
      toolFailures: 0,
      approvalRequests: 1,
      inputRequests: 1,
      rateLimitWarnings: 2,
      rateLimitExhausted: true,
      compactions: 1,
      outputStopReason: "content-filter",
    });
  });

  it("keeps a provider failure's structure and only a redacted single line of its message", () => {
    const diagnostics = diagnose([
      event("failed", 5, {
        failure: {
          category: "provider-failed",
          message: "Process exited\n  token=sk-live-abc123 while reading /Users/someone/project",
          diagnostic: { stage: "launch", kind: "exited", exitCode: 1, stderrContext: undefined },
          retryAfterMs: 30_000,
          usageLimit: { kind: "temporary" },
        },
      }),
    ]);

    expect(diagnostics.failure).toMatchObject({
      category: "provider-failed",
      process: { stage: "launch", kind: "exited", exitCode: 1 },
      retryAfterMs: 30_000,
      usageLimit: "temporary",
    });
    const message = diagnostics.failure?.message ?? "";
    expect(message).not.toMatch(/[\n\r]/);
    expect(message).not.toContain("sk-live-abc123");
    expect(message).not.toContain("/Users/someone");
    expect(message.startsWith("Process exited")).toBe(true);
  });

  it("cuts a long failure message to the stored bound", () => {
    const diagnostics = diagnose([
      event("failed", 1, { failure: { category: "protocol", message: "x".repeat(2_000) } }),
    ]);

    expect(diagnostics.failure?.message?.length).toBe(512);
    expect(() => decodeTurnDiagnostics(diagnostics)).not.toThrow();
  });

  it("keeps the most-called tools when more ran than a frame holds, and says so", () => {
    const events: ProviderRuntimeEvent[] = [];
    for (let index = 0; index < 40; index += 1) {
      events.push(start(index, `call-${index}`, `tool-${String(index).padStart(2, "0")}`));
      events.push(success(index + 0.5, `call-${index}`));
    }
    events.push(start(50, "extra", "tool-39"), success(51, "extra"));
    const diagnostics = diagnose(events);

    expect(diagnostics.toolCalls).toBe(41);
    expect(diagnostics.tools).toHaveLength(32);
    expect(diagnostics.tools?.[0]?.toolName).toBe("tool-39");
    expect(diagnostics.toolsTruncated).toBe(true);
    expect(() => decodeTurnDiagnostics(diagnostics)).not.toThrow();
  });
});
