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
});
