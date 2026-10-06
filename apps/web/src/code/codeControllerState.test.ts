import type {
  ProviderContextBreakdown,
  AggregateVersion,
  CodeCommand,
  CodeThreadId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { commandReloadsThread, totalTurnUsage } from "./codeControllerState";

const threadId = "00000000-0000-4000-8000-000000000001" as CodeThreadId;
const expectedVersion = 1 as AggregateVersion;

describe("commandReloadsThread", () => {
  it("keeps the open conversation when only the thread's model or reasoning changes", () => {
    const reasoning: CodeCommand = {
      kind: "change-code-thread-provider",
      threadId,
      expectedVersion,
      providerInstanceId: "provider" as ProviderInstanceId,
      modelId: "model" as ProviderModelId,
      modelOptionValues: { effort: "high" },
    };
    const rename: CodeCommand = {
      kind: "rename-code-thread",
      threadId,
      expectedVersion,
      title: "Renamed",
    };

    expect(commandReloadsThread(reasoning, threadId)).toBe(false);
    expect(commandReloadsThread(rename, threadId)).toBe(true);
  });
});

describe("totalTurnUsage", () => {
  it("keeps the latest turn's compaction point and drops it when that turn names none", () => {
    const first = {
      inputTokens: 10,
      outputTokens: 2,
      contextTokens: 90_000,
      autoCompactThreshold: 167_000,
    };
    const second = { inputTokens: 12, outputTokens: 3, contextTokens: 95_000 };

    expect(totalTurnUsage(new Map([["a", first]]))).toMatchObject({
      contextTokens: 90_000,
      autoCompactThreshold: 167_000,
    });
    const later = totalTurnUsage(
      new Map([
        ["a", first],
        ["b", second],
      ]),
    );
    expect(later).toMatchObject({ contextTokens: 95_000 });
    // A runtime that stopped promising to compact must not leave the last
    // promise standing as the thread's.
    expect(later).not.toHaveProperty("autoCompactThreshold");
  });

  it("keeps the latest breakdown that was reported while a later turn has not yet reported one", () => {
    const earlier: ProviderContextBreakdown = {
      parts: [{ kind: "messages", tokens: 900, accuracy: "provider-reported" }],
    };
    const settled: ProviderContextBreakdown = {
      parts: [{ kind: "messages", tokens: 2_400, accuracy: "provider-reported" }],
    };
    const first = { inputTokens: 10, outputTokens: 2, contextBreakdown: earlier };
    const second = { inputTokens: 12, outputTokens: 3, contextBreakdown: settled };
    // A turn that is still running has reported usage but not yet its make-up.
    const running = { inputTokens: 14, outputTokens: 1 };

    expect(totalTurnUsage(new Map([["a", first]]))).toMatchObject({ contextBreakdown: earlier });
    expect(
      totalTurnUsage(
        new Map([
          ["a", first],
          ["b", second],
        ]),
      ),
    ).toMatchObject({ contextBreakdown: settled });
    expect(
      totalTurnUsage(
        new Map([
          ["a", first],
          ["b", second],
          ["c", running],
        ]),
      ),
    ).toMatchObject({ contextBreakdown: settled });
    expect(totalTurnUsage(new Map([["a", running]]))).not.toHaveProperty("contextBreakdown");
  });
});
