import { describe, expect, it } from "vitest";
import { decodeThreadToolStep, decodeThreadToolStepList } from "./threadToolStepList";
import { MAX_THREAD_TOOL_STEPS_PER_TURN } from "./threadToolSteps";

const step = { toolCallId: "call-1", toolName: "Read", state: "completed" } as const;

describe("the thread tool step contract", () => {
  it("accepts a tool call with only its id, name, and state", () => {
    expect(decodeThreadToolStep(step)).toEqual(step);
  });

  it("refuses a field that would carry the tool's input or output", () => {
    expect(() => decodeThreadToolStep({ ...step, input: "cat ~/.ssh/id_rsa" })).toThrow();
  });

  it("refuses a summary longer than a Code turn's tool step holds", () => {
    expect(() => decodeThreadToolStep({ ...step, summary: "x".repeat(2_049) })).toThrow();
  });

  it("refuses more tool calls than one turn may keep", () => {
    expect(() =>
      decodeThreadToolStepList(
        Array.from({ length: MAX_THREAD_TOOL_STEPS_PER_TURN + 1 }, (_unused, index) => ({
          ...step,
          toolCallId: `call-${String(index)}`,
        })),
      ),
    ).toThrow();
  });
});

describe("a tool step Octant Shield answered", () => {
  it("keeps Shield's decision on the step and refuses one with an unknown reviewer", () => {
    const decision = {
      reviewer: "octant-shield",
      verdict: "allow",
      stage: "fast-allow",
      rule: "read-only-git",
      reason: "A read-only Git command.",
      latencyMs: 1,
      decidedAt: "2026-10-31T10:00:00.000Z",
    } as const;
    expect(decodeThreadToolStep({ ...step, shield: decision }).shield).toEqual(decision);
    expect(() =>
      decodeThreadToolStep({ ...step, shield: { ...decision, reviewer: "provider" } }),
    ).toThrow();
  });
});
