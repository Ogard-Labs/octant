import type { ComputerUseEvidenceEvent } from "./computerUseRuntime";
import { describe, expect, it, vi } from "vitest";
import { createComputerUseValidationEvidenceRecorder } from "./computerUseValidationEvidence";

const base = {
  sessionId: "10000000-0000-4000-8000-000000000001",
  actionId: "20000000-0000-4000-8000-000000000001",
  correlationId: "30000000-0000-4000-8000-000000000001",
  threadId: "40000000-0000-4000-8000-000000000001",
  requestedBy: {
    kind: "local-user",
    actorId: "50000000-0000-4000-8000-000000000001",
  },
  authority: {
    hostId: "60000000-0000-4000-8000-000000000001",
    mode: "work",
    projectId: "70000000-0000-4000-8000-000000000001",
    rootId: "80000000-0000-4000-8000-000000000001",
    providerInstanceId: "90000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  },
} as const;

describe("computer-use validation evidence recorder", () => {
  it("creates one plan and appends replay-safe correlated evidence in lifecycle order", async () => {
    const appendPlan = vi.fn();
    const appendEvidence = vi.fn();
    let id = 0;
    const recorder = createComputerUseValidationEvidenceRecorder({
      eventStore: { appendPlan, appendEvidence },
      uuid: () => `a0000000-0000-4000-8000-${(++id).toString().padStart(12, "0")}`,
      clock: () => "2026-07-27T21:00:00.000Z",
    });
    const started: ComputerUseEvidenceEvent = {
      ...base,
      event: {
        sequence: 1,
        kind: "session-started",
        occurredAt: "2026-07-27T21:00:00.000Z",
        detail: "Visible computer-use session started.",
      },
    } as ComputerUseEvidenceEvent;
    const observation: ComputerUseEvidenceEvent = {
      ...base,
      event: {
        sequence: 2,
        kind: "observation-recorded",
        occurredAt: "2026-07-27T21:00:01.000Z",
        detail: "Fresh host observation recorded.",
      },
    } as ComputerUseEvidenceEvent;

    await recorder.record(started);
    await recorder.record(observation);

    expect(appendPlan).toHaveBeenCalledOnce();
    expect(appendPlan).toHaveBeenCalledWith({
      expectedVersion: 0,
      plan: expect.objectContaining({ authority: base.authority, steps: [expect.any(Object)] }),
    });
    expect(appendEvidence).toHaveBeenNthCalledWith(1, {
      expectedVersion: 1,
      evidence: expect.objectContaining({
        authority: base.authority,
        outcome: "inconclusive",
        redacted: false,
        source: expect.objectContaining({
          kind: "computer-use-observation",
          actionId: base.actionId,
          correlationId: base.correlationId,
        }),
      }),
    });
    expect(appendEvidence).toHaveBeenNthCalledWith(2, {
      expectedVersion: 2,
      evidence: expect.objectContaining({ redacted: true }),
    });
  });

  it("fails closed on duplicate, skipped, or out-of-order lifecycle evidence", async () => {
    const recorder = createComputerUseValidationEvidenceRecorder({
      eventStore: { appendPlan: vi.fn(), appendEvidence: vi.fn() },
      uuid: () => "a0000000-0000-4000-8000-000000000001",
      clock: () => "2026-07-27T21:00:00.000Z",
    });
    const second = {
      ...base,
      event: {
        sequence: 2,
        kind: "observation-recorded",
        occurredAt: "2026-07-27T21:00:00.000Z",
        detail: "Fresh host observation recorded.",
      },
    } as ComputerUseEvidenceEvent;
    await expect(recorder.record(second)).rejects.toMatchObject({
      message: "Computer-use evidence sequence is invalid.",
    });
  });
});
