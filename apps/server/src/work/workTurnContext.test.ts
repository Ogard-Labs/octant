import { describe, expect, it } from "vitest";
import { decodeWorkThreadId } from "@octant/contracts";
import { includeWorkToolDefinitions, planWorkTurnContext } from "./workTurnContext";

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
      { kind: "instructions", text: expect.stringContaining("Octant's Files") },
      { kind: "user-message", text: "Summarize the brief" },
      { kind: "assistant-message", text: "Here is the summary." },
    ]);
  });

  it("keeps private contribution text out of redacted context metadata", () => {
    let n = 0;
    const text = "Private customer detail: confidential fixture";
    const plan = planWorkTurnContext({
      threadId,
      providerInstanceId: provider,
      modelId: model,
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
      createdAt: "2026-08-11T12:00:00.000Z",
      contributions: [
        {
          text,
          sourceKind: "file",
          referenceId: "selected-file",
          category: "workspace-context",
          posture: "required",
          block: { kind: "instructions", text },
        },
      ],
    });
    if (plan.kind !== "ok") throw new Error("The selected content fits");
    expect(JSON.stringify(plan.manifest)).not.toContain(text);
    expect(plan.context).toContainEqual({ kind: "instructions", text });
  });

  it("budgets the artifact instructions even when the provider has no app-managed tools", () => {
    let n = 0;
    const plan = (safeInputBudget: number) =>
      planWorkTurnContext({
        threadId,
        providerInstanceId: provider,
        modelId: model,
        uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
        createdAt: "2026-08-11T12:00:00.000Z",
        safeInputBudget,
        contributions: [],
      });
    const planned = plan(1_000);
    expect(planned.kind).toBe("ok");
    if (planned.kind !== "ok") throw new Error("The Work guide should fit the budget.");
    expect(planned.context).toEqual([
      { kind: "instructions", text: expect.stringContaining("relative paths") },
    ]);
    expect(JSON.stringify(planned.context)).not.toContain("octant_canvas");
    expect(plan(1).kind).toBe("blocked");
  });

  it("retains attributed context and identifies history omitted from the dispatched turn", () => {
    let n = 0;
    const planned = planWorkTurnContext({
      threadId,
      providerInstanceId: provider,
      modelId: model,
      uuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`,
      createdAt: "2026-08-11T12:00:00.000Z",
      safeInputBudget: 500,
      contributions: [
        {
          text: "x".repeat(8000),
          sourceKind: "message",
          referenceId: "old-reply",
          category: "conversation",
          posture: "compressible",
          block: { kind: "assistant-message", text: "x".repeat(8000) },
        },
      ],
    });
    expect(planned.kind).toBe("ok");
    if (planned.kind !== "ok") return;
    expect(planned.manifest.subject).toEqual({
      aggregateType: "work-thread",
      aggregateId: threadId,
    });
    expect(planned.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "conversation", state: "omitted", includedSize: 0 }),
        expect.objectContaining({ category: "octant-policy", state: "included" }),
      ]),
    );
    expect(planned.context).toHaveLength(1);
    expect(planned.context[0]).toMatchObject({ kind: "instructions" });
  });

  it("makes room for required tools by omitting optional history without sending schemas as text", () => {
    let n = 0;
    const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;
    const plan = planWorkTurnContext({
      threadId,
      providerInstanceId: provider,
      modelId: model,
      uuid,
      createdAt: "2026-08-11T12:00:00.000Z",
      safeInputBudget: 500,
      contributions: [
        {
          text: "h".repeat(800),
          sourceKind: "message",
          referenceId: "history",
          category: "conversation",
          posture: "compressible",
          block: { kind: "assistant-message", text: "h".repeat(800) },
        },
      ],
    });
    if (plan.kind !== "ok") throw new Error("The initial request fits its budget");
    expect(plan.context).toHaveLength(2);
    const final = includeWorkToolDefinitions({
      plan,
      uuid,
      safeInputBudget: 500,
      tools: [
        { name: "required_tool", description: "t".repeat(800), inputSchema: { type: "object" } },
      ],
    });
    expect(final.kind).toBe("ok");
    if (final.kind !== "ok") return;
    expect(final.context).toEqual([plan.context[0]]);
    expect(final.manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "conversation", state: "omitted", includedSize: 0 }),
        expect.objectContaining({
          category: "octant-tools",
          state: "included",
          label: "required_tool",
        }),
      ]),
    );
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
      safeInputBudget: 500,
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
