import { AGENT_MESSAGE_EVENT_NAMES, type EventEnvelope } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { CoordinatorHostTurn } from "../coordinator/coordinatorCountStore";
import { WorkMessageWake, type WorkMessageWakeThread } from "./workMessageWake";

const A = "71000000-0000-4000-8000-0000000000a1";
const B = "71000000-0000-4000-8000-0000000000b2";

function sent(sender: string, recipient: string): EventEnvelope {
  return {
    eventName: AGENT_MESSAGE_EVENT_NAMES.sent,
    payload: {
      kind: "message-sent",
      messageId: "71000000-0000-4000-8000-0000000000c3",
      correlationId: "71000000-0000-4000-8000-0000000000d4",
      senderThreadId: sender,
      recipientThreadId: recipient,
      bodyReference: { contentReference: "a".repeat(64), byteLength: 4 },
      expiresAt: "2026-11-14T12:00:00.000Z",
      occurredAt: "2026-11-13T12:00:00.000Z",
    },
  } as unknown as EventEnvelope;
}

function harness() {
  const threads = new Map<string, WorkMessageWakeThread>();
  const busy = new Set<string>();
  const latestTurn = new Map<string, string>();
  const wakes: Array<{ readonly threadId: string; readonly at: number }> = [];
  const hostTurns = new Map<string, CoordinatorHostTurn>();
  const started: Array<{ readonly threadId: string; readonly prompt: string }> = [];
  let now = Date.parse("2026-11-13T12:00:00.000Z");
  let turn = 0;
  const wake = new WorkMessageWake({
    readThread: (threadId) => threads.get(threadId),
    turnActive: (threadId) => busy.has(threadId),
    latestTurnId: (threadId) => latestTurn.get(threadId),
    startHostTurn: async (threadId, prompt) => {
      turn += 1;
      const turnId = `turn-${String(turn)}`;
      started.push({ threadId, prompt });
      latestTurn.set(threadId, turnId);
      return { status: "started", turnId };
    },
    counts: {
      recordWake: (threadId, at) => wakes.push({ threadId, at }),
      wakesSince: (threadId, since) =>
        wakes.filter((entry) => entry.threadId === threadId && entry.at >= since).length,
      recordHostTurn: (threadId, hostTurn) => hostTurns.set(threadId, hostTurn),
      hostTurn: (threadId) => hostTurns.get(threadId),
    },
    now: () => now,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    wake,
    threads,
    busy,
    latestTurn,
    started,
    settle,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const idle = (overrides: Partial<WorkMessageWakeThread> = {}): WorkMessageWakeThread => ({
  lifecycle: "active",
  messageWake: true,
  completed: false,
  ...overrides,
});

describe("a message waking a Work thread", () => {
  it("starts a turn on an idle Work thread whose Wake when a message arrives switch is on", async () => {
    const h = harness();
    h.threads.set(B, idle());
    h.wake.onCommittedEvents([sent(A, B)]);
    await h.settle();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]?.threadId).toBe(B);
    // The host's own words; the message is in the turn's context as data.
    expect(h.started[0]?.prompt).toContain(`thread ${A} left you a message`);
  });

  it("leaves the message for the next turn when the switch is off, a turn is active, or the thread is done or archived", async () => {
    const h = harness();
    h.threads.set(B, idle({ messageWake: false }));
    h.wake.onCommittedEvents([sent(A, B)]);
    h.threads.set(B, idle());
    h.busy.add(B);
    h.wake.onCommittedEvents([sent(A, B)]);
    h.busy.delete(B);
    h.threads.set(B, idle({ completed: true }));
    h.wake.onCommittedEvents([sent(A, B)]);
    h.threads.set(B, idle({ lifecycle: "archived" }));
    h.wake.onCommittedEvents([sent(A, B)]);
    // A thread this host's Work does not hold (a Code thread) is not woken here.
    h.wake.onCommittedEvents([sent(A, "71000000-0000-4000-8000-0000000000e5")]);
    await h.settle();
    expect(h.started).toEqual([]);
  });

  it("stops two Work threads waking each other after ten rounds, until a person runs a turn", async () => {
    const h = harness();
    h.threads.set(A, idle());
    h.threads.set(B, idle());
    // Each reply comes from the turn the previous message woke.
    for (let round = 0; round < 11; round += 1) {
      const [sender, recipient] = round % 2 === 0 ? [A, B] : [B, A];
      h.wake.onCommittedEvents([sent(sender, recipient)]);
      await h.settle();
    }
    expect(h.started).toHaveLength(10);
    // A turn a person started is hop zero again.
    h.latestTurn.set(A, "a-person-turn");
    h.wake.onCommittedEvents([sent(A, B)]);
    await h.settle();
    expect(h.started).toHaveLength(11);
  });

  it("wakes a Work thread at most thirty times in an hour", async () => {
    const h = harness();
    h.threads.set(B, idle());
    for (let index = 0; index < 32; index += 1) {
      h.wake.onCommittedEvents([sent(A, B)]);
      await h.settle();
    }
    expect(h.started).toHaveLength(30);
    h.advance(61 * 60_000);
    h.wake.onCommittedEvents([sent(A, B)]);
    await h.settle();
    expect(h.started).toHaveLength(31);
  });
});
