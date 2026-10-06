import type {
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
});
