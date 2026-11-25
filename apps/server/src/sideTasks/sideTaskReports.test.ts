import { describe, expect, it } from "vitest";
import {
  sideTaskCompletionReport,
  sideTaskFailureReport,
  sideTaskReportOutcomeForStop,
} from "./sideTaskReports";

const base = {
  parentThreadId: "00000000-0000-4000-8000-0000000000aa",
  parentMode: "chat" as const,
  title: "Fix stale install docs",
  endedAt: "2026-11-24T12:00:00.000Z",
};

describe("the report a child turn owes", () => {
  it("carries a completion's reply whole when it fits", () => {
    const report = sideTaskCompletionReport({ ...base, text: "Updated the docs." });
    expect(report).toMatchObject({ outcome: "completed", text: "Updated the docs." });
    expect(report.truncated).toBeUndefined();
  });

  it("cuts a long reply to what one report carries and admits the cut", () => {
    const report = sideTaskCompletionReport({ ...base, text: "x".repeat(5_000) });
    expect(report.text).toHaveLength(4_096);
    expect(report.truncated).toBe(true);
  });

  it("carries no text for a completion that produced none", () => {
    const report = sideTaskCompletionReport({ ...base, text: "   " });
    expect(report.text).toBeUndefined();
  });

  it("reads a cancellation as a cancellation and a failure as a failure", () => {
    expect(sideTaskReportOutcomeForStop("cancelled")).toBe("cancelled");
    expect(sideTaskReportOutcomeForStop("failed")).toBe("failed");
    expect(sideTaskReportOutcomeForStop("end-of-turn")).toBeUndefined();
    expect(sideTaskReportOutcomeForStop("max-tokens")).toBeUndefined();
  });

  it("carries no text for a failure", () => {
    const report = sideTaskFailureReport({ ...base, outcome: "failed" });
    expect(report).toMatchObject({ outcome: "failed" });
    expect("text" in report).toBe(false);
  });
});
