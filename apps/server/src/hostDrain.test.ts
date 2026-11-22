import { describe, expect, it } from "vitest";
import { HOST_DRAINING_REFUSAL, HostDrain } from "./hostDrain";

describe("draining this host before an update", () => {
  it("is drained once running turns end, and timed out with the count still running once its wait passes", () => {
    let now = 0;
    const drain = new HostDrain({ now: () => now });
    drain.turnStarted({ mode: "chat", threadId: "a" });
    drain.turnStarted({ mode: "code", threadId: "b" });
    expect(drain.status()).toEqual({ state: "not-draining" });
    expect(drain.refusal()).toBeUndefined();

    expect(drain.enter(10)).toEqual({ state: "draining", running: 2 });
    expect(drain.refusal()).toBe(HOST_DRAINING_REFUSAL);
    drain.turnEnded({ mode: "chat", threadId: "a" });
    now = 9 * 60_000;
    expect(drain.status()).toEqual({ state: "draining", running: 1 });
    now = 10 * 60_000;
    expect(drain.status()).toEqual({ state: "timed-out", running: 1 });
    // Timing out cancels nothing: the turn runs on, and new turns stay
    // refused until the update stops the host.
    expect(drain.refusal()).toBe(HOST_DRAINING_REFUSAL);
    drain.turnEnded({ mode: "code", threadId: "b" });
    expect(drain.status()).toEqual({ state: "drained" });
    expect(drain.refusal()).toBe(HOST_DRAINING_REFUSAL);

    drain.lift();
    expect(drain.status()).toEqual({ state: "not-draining" });
    expect(drain.refusal()).toBeUndefined();
  });

  it("lifts by itself a while after its wait when the update never comes back to stop the host", () => {
    let now = 0;
    const drain = new HostDrain({ now: () => now });
    drain.enter(1);
    now = 60_000 + 4 * 60_000;
    expect(drain.refusal()).toBe(HOST_DRAINING_REFUSAL);
    now = 60_000 + 5 * 60_000;
    expect(drain.refusal()).toBeUndefined();
    expect(drain.status()).toEqual({ state: "not-draining" });
  });

  it("counts a turn accepted before its provider starts, and refuses acceptance once draining", () => {
    const drain = new HostDrain({ now: () => 0 });
    expect(drain.accept({ mode: "work", threadId: "a" })).toMatchObject({ status: "accepted" });
    expect(drain.enter(10)).toEqual({ state: "draining", running: 1 });
    expect(drain.accept({ mode: "chat", threadId: "b" })).toEqual({
      status: "refused",
      message: HOST_DRAINING_REFUSAL,
    });
    drain.turnStarted({ mode: "work", threadId: "a" });
    drain.turnEnded({ mode: "work", threadId: "a" });
    expect(drain.status()).toEqual({ state: "drained" });
  });

  it("forgets a turn that ended before its provider started, but never a later turn on the same thread", () => {
    const drain = new HostDrain({ now: () => 0 });
    const refusedBySpend = drain.accept({ mode: "work", threadId: "a" });
    if (refusedBySpend.status !== "accepted") throw new Error("expected acceptance");
    refusedBySpend.release();
    expect(drain.enter(10)).toEqual({ state: "drained" });
    drain.lift();

    const earlier = drain.accept({ mode: "work", threadId: "a" });
    if (earlier.status !== "accepted") throw new Error("expected acceptance");
    drain.turnStarted({ mode: "work", threadId: "a" });
    // A late release from the earlier registration leaves the running turn counted.
    earlier.release();
    expect(drain.enter(10)).toEqual({ state: "draining", running: 1 });
  });
});
