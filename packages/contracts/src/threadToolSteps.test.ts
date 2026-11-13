import { describe, expect, it } from "vitest";
import { decodeThreadToolStep, decodeThreadToolStepList } from "./threadToolStepList";

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

  it("holds as many tool calls as the turn's limit let it keep, which is off at Full access", () => {
    const steps = Array.from({ length: 5_000 }, (_unused, index) => ({
      ...step,
      toolCallId: `call-${String(index)}`,
    }));
    expect(decodeThreadToolStepList(steps)).toHaveLength(5_000);
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

describe("the routine a tool step records", () => {
  const routine = (name: string) => ({
    routineId: "20000000-0000-4000-8000-0000000000a1",
    name,
    trigger: { kind: "once", scheduledAt: "2026-11-12T09:00:00.000Z" },
    firstRunAt: "2026-11-12T09:00:00.000Z",
    paused: true,
  });
  const step = (name: string) => ({
    toolCallId: "r",
    toolName: "octant_propose_routine",
    state: "completed",
    routine: routine(name),
  });

  it("keeps a routine name the routine itself accepts, however many bytes its characters take", () => {
    // 255 Japanese characters is the routine's longest name and far over 256 bytes.
    const name = "あ".repeat(255);
    expect(decodeThreadToolStep(step(name)).routine?.name).toBe(name);
  });

  it("refuses a name longer than the routine's own limit", () => {
    expect(() => decodeThreadToolStep(step("a".repeat(256)))).toThrow();
  });
});
