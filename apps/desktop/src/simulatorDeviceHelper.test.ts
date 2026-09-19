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
  const child: DeviceHelperChild = {
    stdin: {
      write: (chunk) => {
        const bytes = Buffer.from(chunk);
        requests.push(JSON.parse(bytes.subarray(4).toString("utf8")) as Record<string, unknown>);
        return true;
      },
      end: vi.fn(),
    },
    stdout: {
      on: (_event, listener) => {
        emitData = listener;
      },
    },
    frames: {
      on: (_event, listener) => {
        emitFrames = listener;
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
