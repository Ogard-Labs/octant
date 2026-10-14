import type { CodeConversationTurnUsage } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { foldCodeTurnUsage } from "./codeConversationUsage";

const turns: ReadonlyArray<CodeConversationTurnUsage> = [
  {
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 40,
    costUsd: 0.5,
    contextWindow: 200_000,
    contextTokens: 120,
    autoCompactThreshold: 150_000,
  },
  { inputTokens: 50, outputTokens: 5 },
  {
    inputTokens: 70,
    outputTokens: 7,
    cacheReadInputTokens: 20,
    cacheWriteInputTokens: 3,
    costUsd: 0.25,
    contextTokens: 190,
  },
];

describe("Code turn usage fold", () => {
  it("folds nothing to nothing, so a thread with no report shows no zero", () => {
    expect(foldCodeTurnUsage(undefined, [])).toBeUndefined();
  });

  it("sums each turn once and keeps the latest window figures", () => {
    expect(foldCodeTurnUsage(undefined, turns)).toEqual({
      reportedTurns: 3,
      inputTokens: 220,
      outputTokens: 22,
      cacheRead: { measuredTurns: 2, measuredTokens: 60 },
      cacheWrite: { measuredTurns: 1, measuredTokens: 3 },
      costUsd: 0.75,
      contextWindow: 200_000,
      contextTokens: 190,
    });
  });

  it("gives the same total from a seed of the earlier turns as from every turn", () => {
    for (let split = 0; split <= turns.length; split += 1) {
      const seed = foldCodeTurnUsage(undefined, turns.slice(0, split));
      expect(foldCodeTurnUsage(seed, turns.slice(split))).toEqual(
        foldCodeTurnUsage(undefined, turns),
      );
    }
  });

  it("keeps the earlier compaction point only while no later turn reported usage", () => {
    const seed = foldCodeTurnUsage(undefined, turns.slice(0, 1));
    expect(foldCodeTurnUsage(seed, [])?.autoCompactThreshold).toBe(150_000);
    expect(foldCodeTurnUsage(seed, turns.slice(1, 2))?.autoCompactThreshold).toBeUndefined();
  });
});
