import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  recordThreadShieldReview,
  recordThreadToolStep,
  type ThreadToolSteps,
} from "./threadToolSteps";

const base = {
  instanceId: "20000000-0000-4000-8000-000000000001",
  sequence: 1,
  correlationId: "20000000-0000-4000-8000-000000000002",
  occurredAt: "2026-10-15T10:00:00.000Z",
  sessionId: "20000000-0000-4000-8000-000000000003",
};
const event = (fields: Record<string, unknown>) =>
  ({ ...base, ...fields }) as unknown as ProviderRuntimeEvent;

function fold(events: ReadonlyArray<ProviderRuntimeEvent>): ThreadToolSteps | undefined {
  let current: ThreadToolSteps | undefined;
  for (const next of events) current = recordThreadToolStep(current, next);
  return current;
}

describe("a turn's tool steps", () => {
  it("keeps one step per tool call id and updates it in place as the call moves", () => {
    const steps = fold([
      event({ kind: "tool-start", toolCallId: "a", toolName: "Read" }),
      event({ kind: "tool-start", toolCallId: "b", toolName: "Bash" }),
      event({ kind: "tool-progress", toolCallId: "a", message: "Reading notes.md" }),
      event({ kind: "tool-success", toolCallId: "a", summary: "Read 40 lines" }),
      event({ kind: "tool-failure", toolCallId: "b", message: "exit 1" }),
    ]);
    expect(steps).toEqual({
      truncated: false,
      steps: [
        { toolCallId: "a", toolName: "Read", state: "completed", summary: "Read 40 lines" },
        { toolCallId: "b", toolName: "Bash", state: "failed", summary: "exit 1" },
      ],
    });
  });

  it("keeps the page a finished call published, so a reopened Work thread still links it", () => {
    const page = { url: "https://claude.ai/artifact/abc123", title: "Quarterly report" };
    const steps = fold([
      event({ kind: "tool-start", toolCallId: "a", toolName: "Artifact" }),
      event({ kind: "tool-success", toolCallId: "a", summary: "Published.", published: page }),
    ]);
    expect(steps?.steps).toEqual([
      {
        toolCallId: "a",
        toolName: "Artifact",
        state: "completed",
        summary: "Published.",
        published: page,
      },
    ]);
  });

  it("does not reopen a tool that already ended when a late progress message arrives", () => {
    const steps = fold([
      event({ kind: "tool-start", toolCallId: "a", toolName: "Read" }),
      event({ kind: "tool-success", toolCallId: "a", summary: "done" }),
      event({ kind: "tool-progress", toolCallId: "a", message: "late" }),
    ]);
    expect(steps?.steps[0]?.state).toBe("completed");
  });

  it("bounds a long message to the record's size and keeps the first calls when a turn calls too many", () => {
    const long = fold([
      event({ kind: "tool-start", toolCallId: "a", toolName: "Read" }),
      event({ kind: "tool-success", toolCallId: "a", summary: "é".repeat(3_000) }),
    ]);
    expect(new TextEncoder().encode(long?.steps[0]?.summary ?? "").byteLength).toBeLessThanOrEqual(
      2_048,
    );
    const many = fold(
      Array.from({ length: 70 }, (_unused, index) =>
        event({ kind: "tool-start", toolCallId: `call-${String(index)}`, toolName: "Read" }),
      ),
    );
    expect(many?.steps).toHaveLength(64);
    expect(many?.steps[0]?.toolCallId).toBe("call-0");
    expect(many?.truncated).toBe(true);
  });

  it("cuts an oversized tool call id and name to what the contract holds instead of failing", () => {
    const steps = fold([
      event({ kind: "tool-start", toolCallId: "i".repeat(400), toolName: "n".repeat(400) }),
      event({ kind: "tool-success", toolCallId: "i".repeat(400), summary: "ok" }),
    ]);
    expect(steps?.steps).toHaveLength(1);
    expect(steps?.steps[0]?.toolCallId).toHaveLength(255);
    expect(steps?.steps[0]?.toolName).toHaveLength(255);
    expect(steps?.steps[0]?.state).toBe("completed");
  });

  it("ignores events that are not tool calls", () => {
    expect(fold([event({ kind: "text-delta", text: "hi" })])).toBeUndefined();
  });
});

describe("Octant Shield's decisions among a turn's tool steps", () => {
  const decision = {
    reviewer: "octant-shield",
    verdict: "allow",
    stage: "fast-allow",
    rule: "read-only-git",
    reason: "A read-only Git command.",
    latencyMs: 1,
    decidedAt: "2026-10-31T10:00:00.000Z",
  } as unknown as Parameters<typeof recordThreadShieldReview>[1]["decision"];
  const review = { requestId: "approval-1", toolName: "Bash", summary: "git status", decision };

  it("shows a decision as a completed step of its own beside the tool's", () => {
    const tool = fold([event({ kind: "tool-start", toolCallId: "a", toolName: "Bash" })]);
    const steps = recordThreadShieldReview(tool, review);
    expect(steps.steps.map((step) => step.toolCallId)).toEqual(["a", "shield:approval-1"]);
    expect(steps.steps[1]).toMatchObject({ state: "completed", shield: decision });
  });

  it("replaces the step when the same request is reviewed again and drops a decision past the limit", () => {
    const once = recordThreadShieldReview(undefined, review);
    const twice = recordThreadShieldReview(once, { ...review, summary: "git log" });
    expect(twice.steps).toHaveLength(1);
    expect(twice.steps[0]?.summary).toBe("git log");

    let full: ThreadToolSteps | undefined;
    for (let index = 0; index < 64; index += 1) {
      full = recordThreadToolStep(
        full,
        event({ kind: "tool-start", toolCallId: `t${index}`, toolName: "Read" }),
      );
    }
    const over = recordThreadShieldReview(full, review);
    expect(over.steps).toHaveLength(64);
    expect(over.truncated).toBe(true);
  });
});
