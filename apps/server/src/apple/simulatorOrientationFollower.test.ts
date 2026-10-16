import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSimulatorOrientationFollower } from "./simulatorOrientationFollower";

const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";

function follower(reads: Array<"portrait" | "landscape" | undefined> = []) {
  const read = vi.fn(async () => reads.shift());
  const note = vi.fn();
  return { read, note, ...createSimulatorOrientationFollower({ read, note }) };
}

describe("following a Simulator's real orientation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports the real orientation shortly after Home is pressed", async () => {
    const { read, note, afterInput } = follower(["portrait"]);

    afterInput(udid, { kind: "key-press", key: "home" }, "succeeded");
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);

    expect(read).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(udid, "portrait");
  });

  it("reads after a tap but not after typing or a key that cannot change the app", async () => {
    const { read, afterInput } = follower(["landscape"]);

    afterInput(udid, { kind: "type-text" }, "succeeded");
    afterInput(udid, { kind: "key-press", key: "return" }, "succeeded");
    afterInput(udid, { kind: "tap" }, "failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();

    afterInput(udid, { kind: "tap" }, "succeeded");
    await vi.advanceTimersByTimeAsync(700);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a burst of taps once, and never twice within the minimum gap", async () => {
    const { read, afterInput } = follower();

    for (let i = 0; i < 20; i += 1) afterInput(udid, { kind: "tap" }, "succeeded");
    await vi.advanceTimersByTimeAsync(700);
    expect(read).toHaveBeenCalledTimes(1);

    afterInput(udid, { kind: "tap" }, "succeeded");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("re-reads on a slow interval while a live view is open and stops when it ends", async () => {
    const { read, note, whileWatching } = follower(["landscape", "portrait"]);
    const view = new AbortController();

    whileWatching(udid, view.signal);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(note).toHaveBeenLastCalledWith(udid, "landscape");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(note).toHaveBeenLastCalledWith(udid, "portrait");
    expect(read).toHaveBeenCalledTimes(2);

    // 30 seconds of streaming is a handful of reads, not one per frame.
    view.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the last orientation when the screen cannot be read", async () => {
    const { note, afterInput } = follower([undefined]);

    afterInput(udid, { kind: "key-press", key: "home" }, "succeeded");
    await vi.advanceTimersByTimeAsync(700);

    expect(note).not.toHaveBeenCalled();
  });
});
