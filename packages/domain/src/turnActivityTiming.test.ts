import { describe, expect, test } from "vitest";
import type { UtcTimestamp } from "@octant/contracts/events";
import { completedCallDurationMs, createTurnActivityTiming } from "./turnActivityTiming";

const at = (seconds: number): UtcTimestamp =>
  new Date(Date.UTC(2026, 0, 15, 10, 0, seconds)).toISOString() as UtcTimestamp;

describe("turn activity timing", () => {
  test("times one call around a person's approval wait", () => {
    const timing = createTurnActivityTiming();
    // reason0, tool-start12, ask13, answer253, success254
    expect(timing.observeEvent({ isReasoning: true, occurredAt: at(0) })).toBeUndefined();
    expect(timing.observeEvent({ isReasoning: false, occurredAt: at(12) })).toBe(12_000);
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(12) });
    timing.approvalAsked({ approvalId: "a1", occurredAt: at(13), toolCallId: "call-1" });
    timing.approvalAnswered({ approvalId: "a1", occurredAt: at(253) });
    const done = timing.callEnded({ toolCallId: "call-1", occurredAt: at(254) });
    expect(done).toEqual({
      startedAt: at(12),
      endedAt: at(254),
      approvalWaitMs: 240_000,
    });
    expect(completedCallDurationMs(done)).toEqual({ durationMs: 2_000, waitedMs: 240_000 });
    expect(timing.reasoningMs()).toBe(12_000);
  });

  test("sums disjoint reasoning spans without counting the tool between them", () => {
    const timing = createTurnActivityTiming();
    timing.observeEvent({ isReasoning: true, occurredAt: at(0) });
    expect(timing.observeEvent({ isReasoning: false, occurredAt: at(5) })).toBe(5_000);
    timing.observeEvent({ isReasoning: true, occurredAt: at(10) });
    timing.observeEvent({ isReasoning: true, occurredAt: at(12) });
    expect(timing.observeEvent({ isReasoning: false, occurredAt: at(20) })).toBe(15_000);
    expect(timing.reasoningMs()).toBe(15_000);
  });

  test("does not charge a concurrent unrelated call for another call's wait", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "waiting", occurredAt: at(10) });
    timing.callStarted({ toolCallId: "other", occurredAt: at(11) });
    timing.approvalAsked({
      approvalId: "a1",
      occurredAt: at(12),
      toolCallId: "waiting",
    });
    timing.callEnded({ toolCallId: "other", occurredAt: at(20) });
    timing.approvalAnswered({ approvalId: "a1", occurredAt: at(30) });
    const waited = timing.callEnded({ toolCallId: "waiting", occurredAt: at(35) });
    expect(waited).toEqual({
      startedAt: at(10),
      endedAt: at(35),
      approvalWaitMs: 18_000,
    });
    expect(completedCallDurationMs(waited)).toEqual({
      durationMs: 7_000,
      waitedMs: 18_000,
    });
  });

  test("an unattributed ask omits durations its interval could distort", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(0) });
    timing.approvalAsked({ approvalId: "a1", occurredAt: at(5) });
    timing.approvalAnswered({ approvalId: "a1", occurredAt: at(10) });
    expect(timing.callEnded({ toolCallId: "call-1", occurredAt: at(15) })).toBeUndefined();
  });

  test("times a call whose terminal came from the host at the host's finish", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "req-9", occurredAt: at(3) });
    const done = timing.callEnded({ toolCallId: "req-9", occurredAt: at(9) });
    expect(done).toEqual({ startedAt: at(3), endedAt: at(9) });
    expect(completedCallDurationMs(done)).toEqual({ durationMs: 6_000, waitedMs: 0 });
  });

  test("omits timing when the start was synthesized or missing", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({
      toolCallId: "batched",
      occurredAt: at(1),
      provenance: "synthesized",
    });
    expect(timing.callEnded({ toolCallId: "batched", occurredAt: at(4) })).toBeUndefined();
    expect(timing.callEnded({ toolCallId: "never-started", occurredAt: at(4) })).toBeUndefined();
    timing.callStarted({ toolCallId: "bad-stamp", occurredAt: "not-a-time" });
    expect(timing.callEnded({ toolCallId: "bad-stamp", occurredAt: at(4) })).toBeUndefined();
  });

  test("omits timing on out-of-order or malformed bounds", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(10) });
    expect(timing.callEnded({ toolCallId: "call-1", occurredAt: at(5) })).toBeUndefined();
    timing.callStarted({ toolCallId: "call-2", occurredAt: at(10) });
    expect(timing.callEnded({ toolCallId: "call-2", occurredAt: "bad" })).toBeUndefined();
    expect(completedCallDurationMs({ startedAt: at(9), endedAt: at(3) })).toBeUndefined();
  });

  test("a running call carries no timing until its own terminal event", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(0) });
    timing.callStarted({ toolCallId: "call-2", occurredAt: at(1) });
    timing.callEnded({ toolCallId: "call-1", occurredAt: at(5) });
    expect(timing.reasoningMs()).toBe(0);
    expect(timing.callEnded({ toolCallId: "call-2", occurredAt: at(8) })).toEqual({
      startedAt: at(1),
      endedAt: at(8),
    });
  });

  test("synthesized events neither bound reasoning nor end calls", () => {
    const timing = createTurnActivityTiming();
    timing.observeEvent({ isReasoning: true, occurredAt: at(0) });
    // A restated boundary stamps its batch, not an instant: it poisons the
    // open span rather than carry it into the next trustworthy event.
    expect(
      timing.observeEvent({
        isReasoning: false,
        occurredAt: at(50),
        provenance: "synthesized",
      }),
    ).toBeUndefined();
    expect(timing.observeEvent({ isReasoning: false, occurredAt: at(60) })).toBeUndefined();
    // The span it dropped is gone for good; a new one times only itself.
    timing.observeEvent({ isReasoning: true, occurredAt: at(70) });
    expect(timing.observeEvent({ isReasoning: false, occurredAt: at(80) })).toBe(10_000);
  });

  test("reasoning closes at a terminal instant and stays cumulative", () => {
    const timing = createTurnActivityTiming();
    timing.observeEvent({ isReasoning: true, occurredAt: at(2) });
    expect(timing.closeReasoningAt(at(7))).toBe(5_000);
    expect(timing.closeReasoningAt(at(9))).toBeUndefined();
    expect(timing.reasoningMs()).toBe(5_000);
  });

  test("an unbounded answer poisons overlapping calls instead of shrinking them", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(0) });
    timing.approvalAsked({ approvalId: "a1", occurredAt: at(2), toolCallId: "call-1" });
    timing.approvalAnswered({ approvalId: "a1", occurredAt: at(1) });
    expect(timing.callEnded({ toolCallId: "call-1", occurredAt: at(9) })).toBeUndefined();
  });

  test("unions overlapping waits inside the call span instead of charging twice", () => {
    const timing = createTurnActivityTiming();
    const atMs = (ms: number) => new Date(Date.parse(at(0)) + ms).toISOString() as UtcTimestamp;
    // Milliseconds 100–200 and 150–260 of the call were waits: one stretch of
    // 160ms, never 210ms. A separate 100ms wait adds to it, for 260ms.
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(0) });
    timing.approvalAsked({ approvalId: "a1", occurredAt: atMs(100), toolCallId: "call-1" });
    timing.approvalAnswered({ approvalId: "a1", occurredAt: atMs(200) });
    timing.approvalAsked({ approvalId: "a2", occurredAt: atMs(150), toolCallId: "call-1" });
    timing.approvalAnswered({ approvalId: "a2", occurredAt: atMs(260) });
    timing.approvalAsked({ approvalId: "a3", occurredAt: atMs(300), toolCallId: "call-1" });
    timing.approvalAnswered({ approvalId: "a3", occurredAt: atMs(400) });
    expect(timing.callEnded({ toolCallId: "call-1", occurredAt: at(1) })).toEqual({
      startedAt: at(0),
      endedAt: at(1),
      approvalWaitMs: 260,
    });
  });

  test("an ask that outlives its own call never poisons or bills a later one", () => {
    const timing = createTurnActivityTiming();
    timing.callStarted({ toolCallId: "call-1", occurredAt: at(0) });
    timing.approvalAsked({ approvalId: "a1", occurredAt: at(1), toolCallId: "call-1" });
    // The call ended while its ask was still open: its duration is omitted,
    // and the expired ask's late answer bills nothing and stops no one else.
    expect(timing.callEnded({ toolCallId: "call-1", occurredAt: at(4) })).toBeUndefined();
    timing.approvalAnswered({ approvalId: "a1", occurredAt: at(6) });
    timing.callStarted({ toolCallId: "call-2", occurredAt: at(7) });
    expect(timing.callEnded({ toolCallId: "call-2", occurredAt: at(9) })).toEqual({
      startedAt: at(7),
      endedAt: at(9),
    });
  });
});
