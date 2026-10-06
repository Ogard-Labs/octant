import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeChatNavigationThread } from "./chat";
import { decodeCodeNavigationRuntime } from "./code";
import { MAX_LIVE_STEP_ARGUMENT_LENGTH, ThreadLiveStep } from "./threadLiveTurn";
import { decodeWorkThreadNavigationRuntime } from "./workThreads";

const threadId = "00000000-0000-4000-8000-000000000001";
const startedAt = "2026-10-06T12:00:00.000Z";

describe("a navigation row's live turn", () => {
  it("decodes a Code and a Work row with and without the live facts", () => {
    expect(decodeCodeNavigationRuntime({ threadId, executing: true })).not.toHaveProperty(
      "turnStartedAt",
    );
    expect(
      decodeCodeNavigationRuntime({
        threadId,
        executing: true,
        turnStartedAt: startedAt,
        liveStep: { kind: "tool", tool: "Command", argument: "bun run test" },
      }),
    ).toMatchObject({ turnStartedAt: startedAt, liveStep: { argument: "bun run test" } });
    expect(
      decodeWorkThreadNavigationRuntime({
        threadId,
        executing: false,
        liveStep: { kind: "waiting", reason: "approval" },
      }),
    ).toMatchObject({ liveStep: { kind: "waiting", reason: "approval" } });
  });

  it("decodes a Chat row that carries a live turn", () => {
    const row = decodeChatNavigationThread({
      id: threadId,
      title: "Running",
      providerInstanceId: "00000000-0000-4000-8000-000000000002",
      updatedAt: startedAt,
      lastSequence: 3,
      followUpOpen: false,
      executing: true,
      turnStartedAt: startedAt,
      liveStep: { kind: "tool", tool: "Web search" },
    });
    expect(row.liveStep).toEqual({ kind: "tool", tool: "Web search" });
  });

  it("refuses a step that is too long, empty, or carries anything else", () => {
    const decode = Schema.decodeUnknownEither(ThreadLiveStep);
    expect(
      decode({ kind: "tool", tool: "x".repeat(MAX_LIVE_STEP_ARGUMENT_LENGTH + 80) })._tag,
    ).toBe("Left");
    expect(
      decode({
        kind: "tool",
        tool: "Command",
        argument: "x".repeat(MAX_LIVE_STEP_ARGUMENT_LENGTH + 1),
      })._tag,
    ).toBe("Left");
    expect(decode({ kind: "tool", tool: "  " })._tag).toBe("Left");
    expect(decode({ kind: "waiting", reason: "approval", output: "secret" })._tag).toBe("Left");
  });
});
