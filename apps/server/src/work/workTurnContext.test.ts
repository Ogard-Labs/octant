import { describe, expect, it } from "vitest";
import { decodeWorkThreadId } from "@octant/contracts";
import { planWorkTurnContext } from "./workTurnContext";

const threadId = decodeWorkThreadId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const provider = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const model = "model-a";

describe("planWorkTurnContext", () => {
  it("includes prior transcript so a follow-up can see the earlier turn", () => {
    let n = 0;
    const planned = planWorkTurnContext({
      threadId,
      providerInstanceId: provider,
      modelId: model,
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
      createdAt: "2026-08-11T12:00:00.000Z",
      contributions: [
        {
          text: "Summarize the brief",
          sourceKind: "message",
          referenceId: "prior-user",
          category: "conversation",
          posture: "compressible",
          block: { kind: "user-message", text: "Summarize the brief" },
        },
        {
          text: "Here is the summary.",
          sourceKind: "message",
          referenceId: "prior-assistant",
          category: "conversation",
          posture: "compressible",
          block: { kind: "assistant-message", text: "Here is the summary." },
        },
        {
          text: "Revise that",
          sourceKind: "message",
          referenceId: "prompt",
          category: "current-request",
          posture: "required",
          block: { kind: "user-message", text: "Revise that" },
        },
      ],
    });
    expect(planned.kind).toBe("ok");
    if (planned.kind !== "ok") return;
    expect(planned.context).toEqual([
      { kind: "user-message", text: "Summarize the brief" },
      { kind: "assistant-message", text: "Here is the summary." },
    ]);
  });

  it("refuses required file mentions that cannot fit the context budget", () => {
    let n = 0;
    const huge = "a".repeat(8_000);
    const planned = planWorkTurnContext({
      threadId,
      providerInstanceId: provider,
      modelId: model,
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
      createdAt: "2026-08-11T12:00:00.000Z",
      safeInputBudget: 50,
      contributions: [
        {
          text: huge,
          sourceKind: "file",
          referenceId: "notes.md",
          category: "workspace-context",
          posture: "required",
          block: { kind: "user-message", text: huge },
        },
        {
          text: "Use the notes",
          sourceKind: "message",
          referenceId: "prompt",
          category: "current-request",
          posture: "required",
          block: { kind: "user-message", text: "Use the notes" },
        },
      ],
    });
    expect(planned.kind).toBe("blocked");
    if (planned.kind !== "blocked") return;
    expect(planned.message).toContain("input budget");
  });
});
