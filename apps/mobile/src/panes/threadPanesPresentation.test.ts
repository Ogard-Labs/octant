import { describe, expect, it } from "vitest";
import {
  contextMeterPresentation,
  diffstatText,
  folderName,
  listMobileThreadPanes,
  subagentSummary,
} from "./threadPanesPresentation";

describe("the thread panes on the phone", () => {
  it("offers Environment and Review only on a Code thread", () => {
    expect(listMobileThreadPanes("code").map((pane) => pane.id)).toEqual([
      "environment",
      "review",
      "context",
      "agents",
    ]);
    expect(listMobileThreadPanes("chat").map((pane) => pane.id)).toEqual(["context", "agents"]);
    expect(listMobileThreadPanes("work").map((pane) => pane.id)).toEqual(["context", "agents"]);
  });

  it("states a measured context fill and never draws a bar for an unreported one", () => {
    expect(
      contextMeterPresentation({
        kind: "measured",
        usedTokens: 41_000,
        windowTokens: 200_000,
        source: "provider-reported",
      }),
    ).toMatchObject({ fraction: 0.205, label: "41k of 200k (20%)" });
    expect(contextMeterPresentation({ kind: "unreported" }).fraction).toBeUndefined();
    expect(contextMeterPresentation({ kind: "not-planned" }).label).toBe("No context plan yet");
  });

  it("counts subagents as working, to review and done, and says None when nothing was delegated", () => {
    expect(subagentSummary({ active: 2, completed: 3, failed: 0, unacknowledgedResults: 1 })).toBe(
      "2 working · 1 to review · 3 done",
    );
    expect(subagentSummary({ active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 })).toBe(
      "None",
    );
  });

  it("writes a diffstat with a true minus and shows only a folder's own name", () => {
    expect(diffstatText(1_204, 12)).toBe("+1,204 −12");
    expect(folderName("/Users/someone/Dev/octant/.worktrees/panes")).toBe("panes");
  });
});
