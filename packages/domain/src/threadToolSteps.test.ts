import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  markThreadToolStepOutsideContent,
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

describe("the Watcher's tag on a tool step", () => {
  it("keeps the tag through the call's later progress and result", () => {
    const started = fold([event({ kind: "tool-start", toolCallId: "w", toolName: "Fetch" })]);
    const marked = markThreadToolStepOutsideContent(started, {
      toolCallId: "w",
      toolName: "Fetch",
      mark: { labels: ["agent-instructions"] },
    });
    const done = recordThreadToolStep(
      recordThreadToolStep(
        marked,
        event({ kind: "tool-progress", toolCallId: "w", message: "Fetching" }),
      ),
      event({ kind: "tool-success", toolCallId: "w", summary: "Fetched" }),
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
    const first = markThreadToolStepOutsideContent(undefined, {
      toolCallId: "w",
      toolName: "Fetch",
      mark: { labels: ["hidden-text"] },
    });
    const same = markThreadToolStepOutsideContent(first, {
      toolCallId: "w",
      toolName: "Fetch",
      mark: { labels: [] },
    });
    expect(same).toBe(first);
    const more = markThreadToolStepOutsideContent(first, {
      toolCallId: "w",
      toolName: "Fetch",
      mark: { labels: ["encoded-text"] },
    });
    expect(more?.steps[0]?.outsideContent?.labels).toEqual(["hidden-text", "encoded-text"]);
  });

  it("gives a call that announced no start a completed row to carry the tag", () => {
    const steps = markThreadToolStepOutsideContent(undefined, {
      toolCallId: "t1",
      toolName: "web-fetch",
      mark: { labels: [] },
    });
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
