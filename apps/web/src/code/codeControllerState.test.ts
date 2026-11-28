import type {
  ProviderContextBreakdown,
  AggregateVersion,
  CodeCommand,
  CodeOperationEvent,
  CodeThreadId,
  ProviderInstanceId,
  ProviderModelId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  commandReloadsThread,
  approvalCallPreview,
  providerRequestFromEvent,
  totalTurnUsage,
} from "./codeControllerState";
import { applyActivityEvent } from "./transcriptActivity";
import { EMPTY_TURN_ACTIVITY } from "../transcript/turnActivity";

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

describe("providerRequestFromEvent", () => {
  const asked = {
    kind: "approval-requested",
    approvalId: "30000000-0000-4000-8000-000000000003",
    action: "provider-tool",
    summary: "Let this thread use Henrik's iPhone?",
  } as const;

  it("reads an approval an older journal marked for the host's own windows as any other approval", () => {
    expect(providerRequestFromEvent({ ...asked, localPersonOnly: true } as never)).toEqual({
      kind: "approval",
      approvalId: asked.approvalId,
      summary: asked.summary,
    });
  });

  it("names the call an approval gates, so its card can show what would run", () => {
    expect(providerRequestFromEvent({ ...asked, toolCallId: "call-7" } as never)).toEqual({
      kind: "approval",
      approvalId: asked.approvalId,
      summary: asked.summary,
      toolCallId: "call-7",
    });
  });
});

describe("approvalCallPreview", () => {
  // The rows as the journal builds them: the Codex adapter's start names the
  // command, and the progress line after it says only that the tool runs.
  const fold = (...events: ReadonlyArray<Extract<CodeOperationEvent, { kind: "tool-activity" }>>) =>
    new Map([
      [
        "turn-1",
        events.reduce(
          (activity, event) => applyActivityEvent(activity, event),
          EMPTY_TURN_ACTIVITY,
        ),
      ],
    ]);
  const started = (argument?: string) =>
    ({
      kind: "tool-activity",
      toolCallId: "call-7",
      toolName: "Bash",
      state: "started",
      ...(argument === undefined ? {} : { argument }),
    }) satisfies Extract<CodeOperationEvent, { kind: "tool-activity" }>;
  const running = {
    kind: "tool-activity",
    toolCallId: "call-7",
    toolName: "Bash",
    state: "running",
    summary: "Tool is running.",
  } satisfies Extract<CodeOperationEvent, { kind: "tool-activity" }>;

  it("shows the command the gated call was asked to run, not its progress text", () => {
    const activity = fold(started("bun test apps/web/src/composer"), running);
    expect(approvalCallPreview(activity, "call-7")).toBe("bun test apps/web/src/composer");
  });

  it("names nothing when the call's row carries only progress text", () => {
    expect(approvalCallPreview(fold(started(), running), "call-7")).toBeUndefined();
  });

  it("names nothing when the approval names no call, or a call no turn holds", () => {
    const activity = fold(started("bun test apps/web/src/composer"));
    expect(approvalCallPreview(activity, undefined)).toBeUndefined();
    expect(approvalCallPreview(activity, "call-9")).toBeUndefined();
  });
});
