import type {
  AggregateVersion,
  CodeCommand,
  CodeThreadId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { commandReloadsThread } from "./codeControllerState";

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
