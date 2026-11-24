import type { EventEnvelope } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  FinishedReportSettle,
  type FinishedReportSettleOutcome,
  type FinishedReportSettlePorts,
} from "./finishedReportSettle";

/** A committed event standing for a turn the test names, completed or not. */
function turnEvent(threadId: string, turnId: string, status: string): EventEnvelope {
  return { eventName: "turn", payload: { threadId, turnId, status } } as unknown as EventEnvelope;
}

function settler(
  overrides: Partial<FinishedReportSettlePorts> & {
    readonly outcomes?: ReadonlyArray<FinishedReportSettleOutcome>;
  } = {},
) {
  const outcomes = [...(overrides.outcomes ?? [{ status: "settled" as const }])];
  const settle = vi.fn(async () => outcomes.shift() ?? { status: "settled" as const });
  const ports: FinishedReportSettlePorts = {
    turnUpdate: (event) => {
      const payload = event.payload as { threadId: string; turnId: string; status: string };
      return {
        threadId: payload.threadId,
        turnId: payload.turnId,
        completed: payload.status === "completed",
      };
    },
    latestReportTurnId: () => "turn-2",
    enabled: () => true,
    settle,
    wait: async () => undefined,
    ...overrides,
  };
  return { settle, settler: new FinishedReportSettle(ports) };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

describe("settling a thread whose agent filed a finished report", () => {
  it("settles the thread once the turn that filed the report completes", async () => {
    const { settle, settler: subject } = settler();
    subject.onCommittedEvents([turnEvent("thread-a", "turn-2", "completed")]);
    await flush();
    expect(settle).toHaveBeenCalledExactlyOnceWith("thread-a");
  });

  it("leaves the thread alone when another turn completes, or the turn did not complete", async () => {
    const { settle, settler: subject } = settler();
    subject.onCommittedEvents([
      turnEvent("thread-a", "turn-3", "completed"),
      turnEvent("thread-a", "turn-2", "failed"),
      turnEvent("thread-a", "turn-2", "waiting"),
    ]);
    await flush();
    expect(settle).not.toHaveBeenCalled();
  });

  it("settles nothing while the person's switch is off", async () => {
    const { settle, settler: subject } = settler({ enabled: () => false });
    subject.onCommittedEvents([turnEvent("thread-a", "turn-2", "completed")]);
    await flush();
    expect(settle).not.toHaveBeenCalled();
  });

  it("tries again while the turn is still winding down, and stops at any other reason", async () => {
    const busy = { status: "skipped", reason: "busy" } as const;
    const { settle, settler: subject } = settler({ outcomes: [busy, busy, { status: "settled" }] });
    subject.onCommittedEvents([turnEvent("thread-a", "turn-2", "completed")]);
    await flush();
    expect(settle).toHaveBeenCalledTimes(3);

    const decision = { status: "skipped", reason: "decision-pending" } as const;
    const second = settler({ outcomes: [decision] });
    second.settler.onCommittedEvents([turnEvent("thread-b", "turn-2", "completed")]);
    await flush();
    expect(second.settle).toHaveBeenCalledTimes(1);
  });

  it("stops trying once a newer turn starts, so a later turn without a report is not hidden", async () => {
    const busy = { status: "skipped", reason: "busy" } as const;
    let release: () => void = () => undefined;
    const { settle, settler: subject } = settler({
      outcomes: [busy, { status: "settled" }],
      wait: () => new Promise<void>((resolve) => (release = resolve)),
    });
    subject.onCommittedEvents([turnEvent("thread-a", "turn-2", "completed")]);
    await flush();
    expect(settle).toHaveBeenCalledTimes(1);
    // The person sends another message while the first attempt waits.
    subject.onCommittedEvents([turnEvent("thread-a", "turn-3", "running")]);
    release();
    await flush();
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("gives up after a few tries when the thread stays busy", async () => {
    const busy = { status: "skipped", reason: "busy" } as const;
    const { settle, settler: subject } = settler({
      outcomes: [busy, busy, busy, busy, busy, busy, busy],
    });
    subject.onCommittedEvents([turnEvent("thread-a", "turn-2", "completed")]);
    await flush();
    expect(settle).toHaveBeenCalledTimes(5);
  });
});
