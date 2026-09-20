import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimulatorDeviceHelpers, type DeviceHelperChild } from "./simulatorDeviceHelper";

const simulator = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";
const otherSimulator = "348B3796-90BE-4B03-ADC1-46D7468C9D43";

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** A stand-in helper: records what it was sent and answers when the test says so. */
function fakeChild() {
  const requests: Array<Record<string, unknown>> = [];
  let emitData: (chunk: Uint8Array) => void = () => undefined;
  let emitFrames: (chunk: Uint8Array) => void = () => undefined;
  const listeners = new Map<string, () => void>();
  let failStdin: () => void = () => undefined;
  const child: DeviceHelperChild = {
    stdin: {
      write: (chunk) => {
        const bytes = Buffer.from(chunk);
        requests.push(JSON.parse(bytes.subarray(4).toString("utf8")) as Record<string, unknown>);
        return true;
      },
      end: vi.fn(),
      on: (_event, listener) => {
        failStdin = listener;
      },
    },
    stdout: {
      on: (_event, listener) => {
        emitData = listener;
      },
    },
    frames: {
      on: (event, listener) => {
        if (event === "data") emitFrames = listener as (chunk: Uint8Array) => void;
      },
    },
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    kill: vi.fn(),
  };
  return {
    child,
    requests,
    answer: (value: unknown) => emitData(frame(value)),
    answerInPieces: (value: unknown) => {
      const bytes = frame(value);
      emitData(bytes.subarray(0, 3));
      emitData(bytes.subarray(3));
    },
    exit: () => listeners.get("exit")?.(),
    frames: (...chunks: ReadonlyArray<Uint8Array>) => {
      for (const chunk of chunks) emitFrames(chunk);
    },
    breakPipe: () => failStdin(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Simulator device helpers", () => {
  it("starts one helper per Simulator and reuses it for the next input", async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/native/helper", spawn });

    const first = helpers.send(simulator, { op: "tap", x: 0.5, y: 0.25 }, 5_000);
    fake.answer({ id: 1, ok: true });
    await expect(first).resolves.toEqual({ status: "delivered" });
    const second = helpers.send(simulator, { op: "button", button: "home" }, 5_000);
    fake.answerInPieces({ id: 2, ok: true });
    await expect(second).resolves.toEqual({ status: "delivered" });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("/native/helper", simulator);
    expect(fake.requests).toEqual([
      { op: "tap", x: 0.5, y: 0.25, id: 1 },
      { op: "button", button: "home", id: 2 },
    ]);
    helpers.dispose();
  });

  it("reports the helper's own refusal, code and reason", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });

    const reply = helpers.send(simulator, { op: "text", text: "a@b" }, 5_000);
    fake.answer({
      id: 1,
      ok: false,
      code: "unsupported-character",
      message: "only letters, digits, spaces and new lines can be typed",
    });

    await expect(reply).resolves.toEqual({
      status: "refused",
      code: "unsupported-character",
      message: "only letters, digits, spaces and new lines can be typed",
    });
    helpers.dispose();
  });

  it("refuses an identifier that is not a Simulator's without starting anything", async () => {
    const spawn = vi.fn();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn });

    await expect(
      helpers.send("--developer-dir=/tmp", { op: "tap", x: 0, y: 0 }, 5_000),
    ).resolves.toMatchObject({ status: "refused", code: "no-such-device" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops a helper that does not answer in time, and starts a fresh one for the next input", async () => {
    vi.useFakeTimers();
    const stuck = fakeChild();
    const fresh = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(stuck.child).mockReturnValueOnce(fresh.child);
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn });

    const reply = helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(reply).resolves.toMatchObject({ status: "unavailable" });
    expect(stuck.child.kill).toHaveBeenCalled();
    const next = helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 2_000);
    fresh.answer({ id: 1, ok: true });
    await expect(next).resolves.toEqual({ status: "delivered" });
    expect(spawn).toHaveBeenCalledTimes(2);
    helpers.dispose();
  });

  it("answers every waiting input when the helper dies", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });

    const first = helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 5_000);
    const second = helpers.send(simulator, { op: "key", key: "return" }, 5_000);
    expect(helpers.busy()).toBe(true);
    fake.exit();

    await expect(first).resolves.toMatchObject({ status: "unavailable" });
    await expect(second).resolves.toMatchObject({ status: "unavailable" });
    expect(helpers.busy()).toBe(false);
  });

  it("treats a pipe that breaks under a write as the helper being gone, not as a crash", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });

    const reply = helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 5_000);
    // Node reports EPIPE on the stream later, not from `write` itself.
    fake.breakPipe();

    await expect(reply).resolves.toMatchObject({ status: "unavailable" });
    expect(fake.child.kill).toHaveBeenCalled();
  });

  it("counts idle time from the last answer, so a long input is not stopped half way", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({
      helperPath: "/h",
      spawn: () => fake.child,
      idleMs: 1_000,
    });

    const long = helpers.send(simulator, { op: "text", text: "a long passage" }, 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    fake.answer({ id: 1, ok: true });
    await expect(long).resolves.toEqual({ status: "delivered" });

    await vi.advanceTimersByTimeAsync(999);
    expect(fake.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.child.kill).toHaveBeenCalled();
  });

  it("stops a helper that has not answered when the action it serves is cancelled", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const cancelled = new AbortController();

    const reply = helpers.send(simulator, { op: "tap", x: 0.5, y: 0.5 }, 30_000, cancelled.signal);
    // The helper is still looking the device up or probing its input daemon.
    cancelled.abort();

    await expect(reply).resolves.toMatchObject({ status: "unavailable" });
    // Stopped, so the tap it had not sent yet cannot land after the cancel.
    expect(fake.child.kill).toHaveBeenCalled();
  });

  it("leaves a helper alone when a cancel arrives after it already answered", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const cancelled = new AbortController();

    const reply = helpers.send(simulator, { op: "tap", x: 0.5, y: 0.5 }, 30_000, cancelled.signal);
    fake.answer({ id: 1, ok: true });
    await reply;
    cancelled.abort();

    expect(fake.child.kill).not.toHaveBeenCalled();
    helpers.dispose();
  });

  it("stops an idle helper and every helper when the desktop quits", async () => {
    vi.useFakeTimers();
    const idle = fakeChild();
    const other = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(idle.child).mockReturnValueOnce(other.child);
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn, idleMs: 1_000 });

    const delivered = helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 500);
    idle.answer({ id: 1, ok: true });
    await delivered;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(idle.child.kill).toHaveBeenCalled();

    const waiting = helpers.send(otherSimulator, { op: "tap", x: 0.1, y: 0.1 }, 60_000);
    helpers.dispose();
    await expect(waiting).resolves.toMatchObject({ status: "unavailable" });
    expect(other.child.kill).toHaveBeenCalled();
    await expect(
      helpers.send(simulator, { op: "tap", x: 0.1, y: 0.1 }, 500),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("shares one screen stream between viewers and stops it with the last one", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const options = { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };

    const first = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);
    fake.answer({ id: 1, ok: true });
    const firstWatch = await first;
    const secondWatch = await helpers.watch(
      simulator,
      options,
      { onFrame: vi.fn(), onEnd: vi.fn() },
      5_000,
    );
    expect(firstWatch.status).toBe("watching");
    expect(secondWatch.status).toBe("watching");
    expect(fake.requests).toEqual([{ op: "stream-start", ...options, id: 1 }]);

    if (firstWatch.status === "watching") firstWatch.stop();
    expect(fake.requests).toHaveLength(1);
    if (secondWatch.status === "watching") secondWatch.stop();
    expect(fake.requests.at(-1)).toMatchObject({ op: "stream-stop" });
    helpers.dispose();
  });

  it("shows a viewer the screen as it already is, even when nothing on it moves again", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const options = { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };
    const jpeg = Buffer.from([0xff, 0xd8, 0x07, 0xff, 0xd9]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(jpeg.length);

    const first = vi.fn();
    const watching = helpers.watch(simulator, options, { onFrame: first, onEnd: vi.fn() }, 5_000);
    // The helper sends the current screen before it answers the request.
    fake.frames(Buffer.concat([header, jpeg]));
    fake.answer({ id: 1, ok: true });
    await watching;
    expect(first).toHaveBeenCalledTimes(1);

    // A second viewer joins a still device: no new frame will ever be presented.
    const second = vi.fn();
    await helpers.watch(simulator, options, { onFrame: second, onEnd: vi.fn() }, 5_000);
    expect(second).toHaveBeenCalledTimes(1);
    expect(Buffer.from(second.mock.calls[0]?.[0] as Uint8Array)).toEqual(jpeg);
    helpers.dispose();
  });

  it("does not stop a helper that is still typing just because the last viewer left", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const watching = helpers.watch(
      simulator,
      { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      { onFrame: vi.fn(), onEnd: vi.fn() },
      5_000,
    );
    fake.answer({ id: 1, ok: true });
    const watch = await watching;

    const typing = helpers.send(simulator, { op: "text", text: "a long passage" }, 120_000);
    if (watch.status === "watching") watch.stop();
    // The helper answers in order, so the stream cannot be stopped until the
    // typing is done; that wait must not be what stops the helper.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    fake.answer({ id: 2, ok: true });

    await expect(typing).resolves.toEqual({ status: "delivered" });
    helpers.dispose();
  });

  it("does not stop a helper that is still typing just because a viewer's start had to wait behind it", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const typing = helpers.send(simulator, { op: "text", text: "a long passage" }, 120_000);

    // The pane opens while the text is still going in. The helper answers in
    // order, so the stream cannot start until the typing is done.
    const watching = helpers.watch(
      simulator,
      { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      { onFrame: vi.fn(), onEnd: vi.fn() },
      5_000,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    fake.answer({ id: 1, ok: true });
    fake.answer({ id: 2, ok: true });

    await expect(typing).resolves.toEqual({ status: "delivered" });
    await expect(watching).resolves.toMatchObject({ status: "watching" });
    helpers.dispose();
  });

  it("holds a returning viewer's start to its own deadline when only the old stream's stop is waiting", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const options = { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };
    const watching = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);
    fake.answer({ id: 1, ok: true });
    const watch = await watching;
    if (watch.status === "watching") watch.stop();

    // The helper hangs while stopping, and the pane reopens. No input is being
    // delivered, so nothing else would ever end this wait.
    const again = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);
    await vi.advanceTimersByTimeAsync(5_100);

    await expect(again).resolves.toMatchObject({ status: "unavailable" });
    expect(fake.child.kill).toHaveBeenCalled();
    helpers.dispose();
  });

  it("starts a waiting start's clock when the input ahead of it is done, so a stop that hangs cannot hold it", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const options = { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };
    const watching = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);
    fake.answer({ id: 1, ok: true });
    const watch = await watching;
    const typing = helpers.send(simulator, { op: "text", text: "a long passage" }, 120_000);
    if (watch.status === "watching") watch.stop();
    const again = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);

    // While the text is going in, neither the stop nor the start may end the helper.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    fake.answer({ id: 2, ok: true });
    await expect(typing).resolves.toEqual({ status: "delivered" });

    // The stop then hangs. Its clock and the start's began when the typing ended.
    await vi.advanceTimersByTimeAsync(21_000);
    await expect(again).resolves.toMatchObject({ status: "unavailable" });
    expect(fake.child.kill).toHaveBeenCalled();
    helpers.dispose();
  });

  it("does not show a returning viewer a frame the stopping stream sent after everyone had left", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const options = { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };
    const framed = (...bytes: number[]) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      return Buffer.concat([header, Buffer.from(bytes)]);
    };
    const watching = helpers.watch(simulator, options, { onFrame: vi.fn(), onEnd: vi.fn() }, 5_000);
    fake.answer({ id: 1, ok: true });
    const watch = await watching;
    if (watch.status === "watching") watch.stop();
    // The stop is only queued; the old stream presents once more before it ends.
    fake.frames(framed(0xff, 0xd8, 0x01, 0xff, 0xd9));
    fake.answer({ id: 2, ok: true });

    const returning = vi.fn();
    const again = helpers.watch(simulator, options, { onFrame: returning, onEnd: vi.fn() }, 5_000);
    // This time the answer comes before the new stream's own first frame.
    fake.answer({ id: 3, ok: true });
    await again;
    fake.frames(framed(0xff, 0xd8, 0x02, 0xff, 0xd9));

    expect(returning.mock.calls.map(([jpeg]) => (jpeg as Uint8Array)[2])).toEqual([0x02]);
    helpers.dispose();
  });

  it("hands every viewer each whole frame, however the bytes arrive", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const onFrame = vi.fn();
    const watching = helpers.watch(
      simulator,
      { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      { onFrame, onEnd: vi.fn() },
      5_000,
    );
    fake.answer({ id: 1, ok: true });
    await watching;

    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(jpeg.length);
    const wire = Buffer.concat([header, jpeg, header, jpeg]);
    fake.frames(wire.subarray(0, 6), wire.subarray(6, 13), wire.subarray(13));

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(Buffer.from(onFrame.mock.calls[0]?.[0] as Uint8Array)).toEqual(jpeg);
    helpers.dispose();
  });

  it("tells viewers when the helper stops, and keeps a watched helper past the idle window", async () => {
    vi.useFakeTimers();
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({
      helperPath: "/h",
      spawn: () => fake.child,
      idleMs: 1_000,
    });
    const onEnd = vi.fn();
    const watching = helpers.watch(
      simulator,
      { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      { onFrame: vi.fn(), onEnd },
      500,
    );
    fake.answer({ id: 1, ok: true });
    await watching;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
    fake.exit();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("reports the helper's refusal to stream and keeps no viewer", async () => {
    const fake = fakeChild();
    const helpers = createSimulatorDeviceHelpers({ helperPath: "/h", spawn: () => fake.child });
    const onEnd = vi.fn();

    const watching = helpers.watch(
      simulator,
      { maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      { onFrame: vi.fn(), onEnd },
      5_000,
    );
    fake.answer({ id: 1, ok: false, code: "not-booted", message: "the Simulator is Shutdown" });

    await expect(watching).resolves.toEqual({
      status: "refused",
      code: "not-booted",
      message: "the Simulator is Shutdown",
    });
    fake.exit();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
