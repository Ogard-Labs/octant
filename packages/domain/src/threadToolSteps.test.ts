import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  changedThreadToolStep,
  markThreadToolStepOutsideContent,
  markThreadToolStepRoutine,
  recordThreadAppToolStep,
  recordThreadShieldReview,
  recordThreadToolStep,
  threadToolStepLimit,
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

function fold(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  // A rest tuple, so a caller can pass `undefined` (no limit) and mean it.
  ...limit: [] | [number | undefined]
): ThreadToolSteps | undefined {
  let current: ThreadToolSteps | undefined;
  for (const next of events) {
    current = recordThreadToolStep(current, next, limit.length === 0 ? 64 : limit[0]);
  }
  return current;
}

const starts = (count: number) =>
  Array.from({ length: count }, (_unused, index) =>
    event({ kind: "tool-start", toolCallId: `call-${String(index)}`, toolName: "Read" }),
  );

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

  it("keeps as many calls as the limit a person set, and every call when the limit is off", () => {
    const three = fold(starts(5), 3);
    expect(three?.steps.map((step) => step.toolCallId)).toEqual(["call-0", "call-1", "call-2"]);
    expect(three?.truncated).toBe(true);
    const unlimited = fold(starts(200), undefined);
    expect(unlimited?.steps).toHaveLength(200);
    expect(unlimited?.truncated).toBe(false);
  });

  it("names the one step an event changed, so a change can be sent without the whole list", () => {
    const before = fold(starts(3));
    const after = recordThreadToolStep(
      before,
      event({ kind: "tool-success", toolCallId: "call-1", summary: "done" }),
      64,
    );
    expect(changedThreadToolStep(before, after)).toMatchObject({
      toolCallId: "call-1",
      state: "completed",
    });
    const added = recordThreadToolStep(
      after,
      event({ kind: "tool-start", toolCallId: "call-9", toolName: "Bash" }),
      64,
    );
    expect(changedThreadToolStep(after, added)?.toolCallId).toBe("call-9");
    expect(changedThreadToolStep(added, added)).toBeUndefined();
    expect(changedThreadToolStep(undefined, before)?.toolCallId).toBe("call-2");
  });
});

describe("the tool-step limit a turn runs under", () => {
  const settings = { toolStepsPerTurn: 64, fullAccessToolStepsPerTurn: 0 };

  it("is 64 below Full access and off at Full access until a person sets a number", () => {
    expect(threadToolStepLimit({ fullAccess: false, settings })).toBe(64);
    expect(threadToolStepLimit({ fullAccess: true, settings })).toBeUndefined();
  });

  it("is the number a person set for the level the turn runs at", () => {
    const chosen = { toolStepsPerTurn: 200, fullAccessToolStepsPerTurn: 1_000 };
    expect(threadToolStepLimit({ fullAccess: false, settings: chosen })).toBe(200);
    expect(threadToolStepLimit({ fullAccess: true, settings: chosen })).toBe(1_000);
  });
});

describe("the row of a tool Octant ran for a turn whose runtime announces no call", () => {
  it("shows the call as started, then completed or failed, under the id its record is kept by", () => {
    const started = recordThreadAppToolStep(
      undefined,
      { toolCallId: "call-1", toolName: "read-file", state: "started" },
      64,
    );
    expect(started?.steps).toEqual([
      { toolCallId: "call-1", toolName: "read-file", state: "started" },
    ]);
    const done = recordThreadAppToolStep(
      started,
      { toolCallId: "call-1", toolName: "read-file", state: "completed" },
      64,
    );
    expect(done?.steps).toEqual([
      { toolCallId: "call-1", toolName: "read-file", state: "completed" },
    ]);
    const failed = recordThreadAppToolStep(
      done,
      { toolCallId: "call-2", toolName: "run-command", state: "failed" },
      64,
    );
    expect(failed?.steps[1]).toEqual({
      toolCallId: "call-2",
      toolName: "run-command",
      state: "failed",
    });
  });

  it("keeps the Watcher's tag and the routine the call's row already carries", () => {
    const marked = markThreadToolStepOutsideContent(
      recordThreadAppToolStep(
        undefined,
        { toolCallId: "call-1", toolName: "web-fetch", state: "started" },
        64,
      ),
      { toolCallId: "call-1", toolName: "web-fetch", mark: { labels: ["hidden-text"] } },
      64,
    );
    const done = recordThreadAppToolStep(
      marked,
      { toolCallId: "call-1", toolName: "web-fetch", state: "completed" },
      64,
    );
    expect(done?.steps[0]).toEqual({
      toolCallId: "call-1",
      toolName: "web-fetch",
      state: "completed",
      outsideContent: { labels: ["hidden-text"] },
    });
    expect(recordThreadAppToolStep(done, done?.steps[0] as never, 64)).toBe(done);
  });

  it("marks the list truncated instead of adding a row past the limit", () => {
    const full = fold(starts(2), 2);
    const over = recordThreadAppToolStep(
      full,
      { toolCallId: "call-9", toolName: "read-file", state: "started" },
      2,
    );
    expect(over?.steps).toHaveLength(2);
    expect(over?.truncated).toBe(true);
  });
});

describe("the Watcher's tag on a tool step", () => {
  it("keeps the tag through the call's later progress and result", () => {
    const started = fold([event({ kind: "tool-start", toolCallId: "w", toolName: "Fetch" })]);
    const marked = markThreadToolStepOutsideContent(
      started,
      {
        toolCallId: "w",
        toolName: "Fetch",
        mark: { labels: ["agent-instructions"] },
      },
      64,
    );
    const done = recordThreadToolStep(
      recordThreadToolStep(
        marked,
        event({ kind: "tool-progress", toolCallId: "w", message: "Fetching" }),
        64,
      ),
      event({ kind: "tool-success", toolCallId: "w", summary: "Fetched" }),
      64,
    );
    expect(done?.steps).toEqual([
      {
        toolCallId: "w",
        toolName: "Fetch",
        state: "completed",
        summary: "Fetched",
        outsideContent: { labels: ["agent-instructions"] },
      },
    ]);
  });

  it("keeps labels already found when a later mark adds none, and adds new ones", () => {
    const first = markThreadToolStepOutsideContent(
      undefined,
      {
        toolCallId: "w",
        toolName: "Fetch",
        mark: { labels: ["hidden-text"] },
      },
      64,
    );
    const same = markThreadToolStepOutsideContent(
      first,
      {
        toolCallId: "w",
        toolName: "Fetch",
        mark: { labels: [] },
      },
      64,
    );
    expect(same).toBe(first);
    const more = markThreadToolStepOutsideContent(
      first,
      {
        toolCallId: "w",
        toolName: "Fetch",
        mark: { labels: ["encoded-text"] },
      },
      64,
    );
    expect(more?.steps[0]?.outsideContent?.labels).toEqual(["hidden-text", "encoded-text"]);
  });

  it("gives a call that announced no start a completed row to carry the tag", () => {
    const steps = markThreadToolStepOutsideContent(
      undefined,
      {
        toolCallId: "t1",
        toolName: "web-fetch",
        mark: { labels: [] },
      },
      64,
    );
    expect(steps?.steps).toEqual([
      {
        toolCallId: "t1",
        toolName: "web-fetch",
        state: "completed",
        outsideContent: { labels: [] },
      },
    ]);
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

  it("keeps the routine a call created through the call's later progress and result", () => {
    const routine = {
      routineId: "20000000-0000-4000-8000-0000000000a1",
      name: "Daily summary",
      trigger: { kind: "once" as const, scheduledAt: "2026-11-12T09:00:00.000Z" },
      firstRunAt: "2026-11-12T09:00:00.000Z",
      paused: true,
    };
    const started = fold([
      event({ kind: "tool-start", toolCallId: "r", toolName: "octant_propose_routine" }),
    ]);
    const marked = markThreadToolStepRoutine(
      started,
      {
        toolCallId: "r",
        toolName: "octant_propose_routine",
        routine: routine as never,
      },
      64,
    );
    expect(marked?.steps[0]?.routine).toMatchObject({ name: "Daily summary", paused: true });
    const finished = recordThreadToolStep(
      recordThreadToolStep(
        marked,
        event({ kind: "tool-progress", toolCallId: "r", message: "working" }),
        64,
      ),
      event({ kind: "tool-success", toolCallId: "r", summary: "done" }),
      64,
    );
    expect(finished?.steps[0]).toMatchObject({ state: "completed", routine: { paused: true } });
  });

  it("gives a call that announced no start a completed row to carry its routine", () => {
    const marked = markThreadToolStepRoutine(
      undefined,
      {
        toolCallId: "r",
        toolName: "octant_propose_routine",
        routine: {
          routineId: "20000000-0000-4000-8000-0000000000a1",
          name: "Daily summary",
          trigger: { kind: "once", scheduledAt: "2026-11-12T09:00:00.000Z" },
          firstRunAt: "2026-11-12T09:00:00.000Z",
          paused: false,
        } as never,
      },
      64,
    );
    expect(marked?.steps).toHaveLength(1);
    expect(marked?.steps[0]).toMatchObject({ state: "completed", routine: { paused: false } });
  });

  it("shows a decision as a completed step of its own beside the tool's", () => {
    const tool = fold([event({ kind: "tool-start", toolCallId: "a", toolName: "Bash" })]);
    const steps = recordThreadShieldReview(tool, review, 64);
    expect(steps.steps.map((step) => step.toolCallId)).toEqual(["a", "shield:approval-1"]);
    expect(steps.steps[1]).toMatchObject({ state: "completed", shield: decision });
  });

  it("replaces the step when the same request is reviewed again and drops a decision past the limit", () => {
    const once = recordThreadShieldReview(undefined, review, 64);
    const twice = recordThreadShieldReview(once, { ...review, summary: "git log" }, 64);
    expect(twice.steps).toHaveLength(1);
    expect(twice.steps[0]?.summary).toBe("git log");

    let full: ThreadToolSteps | undefined;
    for (let index = 0; index < 64; index += 1) {
      full = recordThreadToolStep(
        full,
        event({ kind: "tool-start", toolCallId: `t${index}`, toolName: "Read" }),
        64,
      );
    }
    const over = recordThreadShieldReview(full, review, 64);
    expect(over.steps).toHaveLength(64);
    expect(over.truncated).toBe(true);
  });
});
