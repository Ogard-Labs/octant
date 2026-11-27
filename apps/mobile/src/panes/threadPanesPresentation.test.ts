import { describe, expect, it } from "vitest";
import {
  contextMeterPresentation,
  diffstatText,
  folderName,
  listMobileThreadPanes,
  numberedDiffLines,
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

describe("a file's diff with its line numbers", () => {
  it("counts old and new numbers from each hunk header", () => {
    const lines = numberedDiffLines([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ fn" },
      { kind: "context", text: " a" },
      { kind: "removed", text: "-b" },
      { kind: "added", text: "+B" },
      { kind: "context", text: " c" },
      { kind: "hunk", text: "@@ -40,2 +40,3 @@" },
      { kind: "context", text: " d" },
      { kind: "added", text: "+e" },
    ]);
    expect(lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [undefined, undefined],
      [10, 10],
      [11, undefined],
      [undefined, 11],
      [12, 12],
      [undefined, undefined],
      [40, 40],
      [undefined, 41],
    ]);
  });

  it("numbers a new file from one", () => {
    const lines = numberedDiffLines([
      { kind: "hunk", text: "@@ -0,0 +1,3 @@" },
      { kind: "added", text: "+x" },
      { kind: "added", text: "+y" },
    ]);
    expect(lines.map((line) => [line.oldNumber, line.newNumber])).toEqual([
      [undefined, undefined],
      [undefined, 1],
      [undefined, 2],
    ]);
  });

  it("leaves lines before any hunk unnumbered", () => {
    const lines = numberedDiffLines([
      { kind: "context", text: "diff --git a b" },
      { kind: "added", text: "+z" },
    ]);
    expect(
      lines.every((line) => line.oldNumber === undefined && line.newNumber === undefined),
    ).toBe(true);
  });
});
