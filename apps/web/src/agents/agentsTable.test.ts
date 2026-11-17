import { describe, expect, it } from "vitest";
import { agentStatusTone, runTimeCell, startedCell, usageCell } from "./agentsTable";

const now = "2026-08-01T12:00:00.000Z";

describe("agent table cells", () => {
  it("reads a live run's time up to now", () => {
    const base = { createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:12:00.000Z" };
    expect(runTimeCell({ ...base, lifecycleStatus: "running" }, now)).toBe("2h 0m");
  });

  it("leaves a stopped run's time blank, because acknowledging it later moves its last update", () => {
    // Completed at 10:05, acknowledged at 14:00: the run did not work for four hours.
    const acknowledged = {
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T14:00:00.000Z",
    };
    expect(runTimeCell({ ...acknowledged, lifecycleStatus: "completed" }, now)).toBe("");
    expect(runTimeCell({ ...acknowledged, lifecycleStatus: "failed" }, now)).toBe("");
  });

  it("leaves the run time blank for a run that has not begun", () => {
    const base = { createdAt: "2026-08-01T11:59:00.000Z", updatedAt: "2026-08-01T11:59:00.000Z" };
    expect(runTimeCell({ ...base, lifecycleStatus: "queued" }, now)).toBe("");
    expect(runTimeCell({ ...base, lifecycleStatus: "starting" }, now)).toBe("");
  });

  it("says when a run started in short words", () => {
    expect(startedCell("2026-08-01T11:48:00.000Z", now)).toBe("12m ago");
    expect(startedCell("2026-08-01T11:59:50.000Z", now)).toBe("just now");
    expect(startedCell("2026-07-30T03:00:00.000Z", now)).toBe("2d 9h ago");
  });

  it("shows usage only when a provider reported it, and an estimate as a word", () => {
    expect(
      usageCell({
        usageQuality: "provider-reported",
        usage: { inputTokens: 12_000, outputTokens: 3_400 },
      }),
    ).toEqual({ primary: "15.4k", secondary: "12k in · 3.4k out" });
    expect(usageCell({ usageQuality: "estimated" })).toEqual({
      primary: "Estimated",
      secondary: "",
    });
    expect(usageCell({ usageQuality: "unavailable" })).toEqual({ primary: "", secondary: "" });
    expect(usageCell({ usageQuality: "stale" })).toEqual({ primary: "", secondary: "" });
  });

  it("gives failed and interrupted runs one tone and a cancelled run a quiet one", () => {
    expect(agentStatusTone("failed")).toBe("failure");
    expect(agentStatusTone("interrupted")).toBe("failure");
    expect(agentStatusTone("cancelled")).toBe("quiet");
    expect(agentStatusTone("waiting")).toBe("active");
    expect(agentStatusTone("completed")).toBe("success");
  });
});
