import { describe, expect, it } from "vitest";
import { forestRun } from "./agentRunForest.fixture";
import {
  agentRunGraphUsageLine,
  formatAgentRunRecency,
  formatAgentRunTokenCount,
} from "./agentRunGraphFacts";

describe("formatAgentRunRecency", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  it("names a just-finished run without inventing a clock", () => {
    expect(formatAgentRunRecency("2026-08-01T11:59:55.000Z", now)).toBe("just now");
  });

  it("counts seconds and minutes from the given now", () => {
    expect(formatAgentRunRecency("2026-08-01T11:59:20.000Z", now)).toBe("40s ago");
    expect(formatAgentRunRecency("2026-08-01T11:10:00.000Z", now)).toBe("50m ago");
  });
});

describe("formatAgentRunTokenCount", () => {
  it("keeps small counts exact and abbreviates thousands and millions", () => {
    expect(formatAgentRunTokenCount(143)).toBe("143");
    expect(formatAgentRunTokenCount(14_700)).toBe("14.7k");
    expect(formatAgentRunTokenCount(18_200_000)).toBe("18.2m");
  });
});

describe("agentRunGraphUsageLine", () => {
  it("labels IN and OUT only for provider-reported totals", () => {
    const summary = forestRun({
      runId: "11111111-1111-4111-8111-111111111111",
      task: "Lead",
    });
    const reported = {
      ...summary,
      usageQuality: "provider-reported" as const,
      usage: { inputTokens: 14_700, outputTokens: 28000 },
    };
    expect(agentRunGraphUsageLine(reported)).toBe("IN 14.7k · OUT 28k");
  });

  it("does not invent zeros when usage was not reported", () => {
    const summary = forestRun({
      runId: "21111111-1111-4111-8111-111111111111",
      task: "Lead",
    });
    expect(agentRunGraphUsageLine({ ...summary, usageQuality: "unavailable" })).toBeUndefined();
    expect(agentRunGraphUsageLine({ ...summary, usageQuality: "estimated" })).toBe(
      "Estimated usage",
    );
  });
});
