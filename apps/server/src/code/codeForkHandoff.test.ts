import { describe, expect, it, vi } from "vitest";
import { buildCodeForkHandoff, type CodeForkHandoffTurn } from "./codeForkHandoff";

const windowId = "90000000-0000-4000-8000-000000000001" as never;
const sourceThreadId = "90000000-0000-4000-8000-000000000002" as never;

function turn(index: number, status = "completed"): CodeForkHandoffTurn {
  return {
    operationId: `operation-${index}` as never,
    prompt: { contentId: `prompt-${index}` },
    assistant: [{ contentId: `answer-${index}` }],
    status,
    startedAt: "2026-08-17T09:00:00.000Z",
    updatedAt: "2026-08-17T09:01:00.000Z",
  };
}

function options(
  turns: ReadonlyArray<CodeForkHandoffTurn>,
  text: (contentId: string) => string | undefined = (contentId) => contentId,
) {
  return {
    conversation: vi.fn(async () => ({ turns, nextCursor: 1, hasMore: false })),
    readEvidence: vi.fn(async (_window: never, _thread: never, _operation: never, id: string) => {
      const value = text(id);
      if (value === undefined) throw new Error("unavailable");
      return { bytes: new TextEncoder().encode(value) };
    }),
  };
}

describe("buildCodeForkHandoff", () => {
  it("carries the source conversation up to the fork point and nothing after it", async () => {
    const handoff = await buildCodeForkHandoff(options([turn(1), turn(2), turn(3)]), {
      windowId,
      origin: { threadId: sourceThreadId, throughOperationId: "operation-2" as never },
    });

    expect(handoff).toContain("User: prompt-1");
    expect(handoff).toContain("Assistant: answer-1");
    expect(handoff).toContain("User: prompt-2");
    expect(handoff).toContain("Assistant: answer-2");
    // The turn after the fork is a direction the fork explicitly did not take.
    expect(handoff).not.toContain("prompt-3");
    expect(handoff).toContain("act only on the message that follows it");
  });

  it("never quotes an answer from a turn that did not complete", async () => {
    const handoff = await buildCodeForkHandoff(options([turn(1, "interrupted")]), {
      windowId,
      origin: { threadId: sourceThreadId, throughOperationId: "operation-1" as never },
    });

    expect(handoff).toContain("User: prompt-1");
    expect(handoff).not.toContain("answer-1");
  });

  it("hands over nothing when the fork point is not in the source conversation", async () => {
    await expect(
      buildCodeForkHandoff(options([turn(1), turn(2)]), {
        windowId,
        origin: { threadId: sourceThreadId, throughOperationId: "operation-9" as never },
      }),
    ).resolves.toBeUndefined();
  });

  it("hands over nothing rather than a claimed history when the source cannot be read", async () => {
    const unreadable = {
      conversation: vi.fn(async () => {
        throw new Error("journal unavailable");
      }),
      readEvidence: vi.fn(async () => ({ bytes: new Uint8Array() })),
    };
    await expect(
      buildCodeForkHandoff(unreadable as never, {
        windowId,
        origin: { threadId: sourceThreadId, throughOperationId: "operation-1" as never },
      }),
    ).resolves.toBeUndefined();

    // Evidence the host cannot serve leaves the entry out, not a placeholder.
    await expect(
      buildCodeForkHandoff(
        options([turn(1)], () => undefined),
        {
          windowId,
          origin: { threadId: sourceThreadId, throughOperationId: "operation-1" as never },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("drops the oldest turns first when the handoff exceeds its budget", async () => {
    const long = "x".repeat(3_500);
    const turns = Array.from({ length: 30 }, (_, index) => turn(index + 1));
    const handoff = await buildCodeForkHandoff(
      options(turns, (contentId) => `${contentId} ${long}`),
      {
        windowId,
        origin: { threadId: sourceThreadId, throughOperationId: "operation-30" as never },
      },
    );

    expect(handoff).toBeDefined();
    expect(handoff!.length).toBeLessThanOrEqual(48_500);
    // The turn the fork branched from is the one it continues, so it survives.
    expect(handoff).toContain("prompt-30");
    expect(handoff).not.toContain("prompt-1 ");
  });
});
