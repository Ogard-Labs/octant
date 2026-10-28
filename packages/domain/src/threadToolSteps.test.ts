import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { recordThreadToolStep, type ThreadToolSteps } from "./threadToolSteps";

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
