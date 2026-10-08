import { describe, expect, it, vi } from "vitest";
import { createManagedSimulatorHelpers, readInputConnection } from "./managedSimulatorHelpers";
import type { DeviceHelperReply, SimulatorDeviceHelpers } from "./simulatorDeviceHelper";

const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";
const jpeg = Uint8Array.of(0xff, 0xd8, 0x01, 0xff, 0xd9);

const script = `
const args = process.argv.slice(1);
const udid = ${JSON.stringify(udid)};
if (args.includes("--no-preview")) {
  const host = process.env.OCTANT_TEST_STREAM_HOST ?? "127.0.0.1";
  console.log(JSON.stringify({
    device: udid,
    url: "http://" + host + ":9",
    streamUrl: "http://" + host + ":9/helper/" + udid + "/stream.mjpeg",
    port: 9,
    pid: process.pid,
  }));
  setInterval(() => {}, 1000);
} else {
  const fail = process.env.OCTANT_TEST_CONTROL_EXIT;
  if (fail === "1") process.exit(1);
  const gestureAt = args.indexOf("gesture");
  if (fail === "move" && gestureAt !== -1) {
    const body = JSON.parse(args[gestureAt + 1]);
    if (body.type === "move") process.exit(1);
  }
  process.exit(0);
}
`;

function nativeHelpers(): SimulatorDeviceHelpers & {
  readonly send: ReturnType<typeof vi.fn>;
  readonly watch: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(async (): Promise<DeviceHelperReply> => ({ status: "delivered" })),
    watch: vi.fn(async () => ({ status: "unavailable" as const, message: "native watch" })),
    busy: () => false,
    dispose: vi.fn(() => undefined),
  };
}

function tools(
  options: {
    readonly failTap?: boolean;
    readonly failGestureMove?: boolean;
    readonly badHost?: boolean;
  } = {},
) {
  const commands: Array<ReadonlyArray<string>> = [];
  return {
    commands,
    launchSpec: async (_tool: string, args: ReadonlyArray<string>) => {
      commands.push(args);
      return {
        command: process.execPath,
        args: ["-e", script, "--", ...args],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          ...(options.failTap === true && args[0] === "tap"
            ? { OCTANT_TEST_CONTROL_EXIT: "1" }
            : {}),
          ...(options.failGestureMove === true ? { OCTANT_TEST_CONTROL_EXIT: "move" } : {}),
          ...(options.badHost === true ? { OCTANT_TEST_STREAM_HOST: "192.168.1.8" } : {}),
        },
      };
    },
    trackProcess: vi.fn(),
  };
}

const connected = async () => "connected" as const;

const fetchStream: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/config")) {
    return new Response(JSON.stringify({ width: 1170, height: 2532 }));
  }
  if (url.endsWith("/stream.mjpeg")) return new Response(jpeg);
  return new Response("missing", { status: 404 });
};

describe("managed simulator streams", () => {
  it("uses the native helper when serve-sim cannot be launched", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(
      native,
      {
        launchSpec: async () => undefined,
        trackProcess: vi.fn(),
      },
      { inputConnection: connected },
    );
    await expect(helpers.send(udid, { op: "hello" }, 1_000)).resolves.toEqual({
      status: "delivered",
    });
    expect(native.send).toHaveBeenCalledOnce();
    helpers.dispose();
  });

  it("reports the stream screen and shows a JPEG without the native helper", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await expect(helpers.send(udid, { op: "hello" }, 2_000)).resolves.toEqual({
        status: "delivered",
        screen: { width: 1170, height: 2532 },
      });
      const frames: Uint8Array[] = [];
      const watch = await helpers.watch(
        udid,
        { maxHeight: 100, quality: 0.5, framesPerSecond: 1 },
        {
          onFrame: (frame) => frames.push(frame),
          onEnd: () => undefined,
        },
        1_000,
      );
      expect(watch.status).toBe("watching");
      expect(frames[0]).toEqual(jpeg);
      expect(native.watch).not.toHaveBeenCalled();
      if (watch.status === "watching") watch.stop();
    } finally {
      helpers.dispose();
    }
  });

  it("taps through serve-sim and does not also tap through the native helper", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await expect(helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000)).resolves.toEqual({
        status: "delivered",
      });
      expect(managed.commands).toContainEqual(["tap", "0.5", "0.25", "-d", udid]);
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("sends input Device Hub took through the native helper instead of serve-sim", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: async () => "disconnected",
    });
    try {
      await expect(helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000)).resolves.toEqual({
        status: "delivered",
      });
      await helpers.send(udid, { op: "touch", phase: "down", x: 0.2, y: 0.3 }, 2_000);
      await helpers.send(udid, { op: "touch", phase: "move", x: 0.4, y: 0.5 }, 2_000);
      await helpers.send(udid, { op: "touch", phase: "up", x: 0.4, y: 0.5 }, 2_000);
      expect(native.send.mock.calls.map(([, request]) => request)).toEqual([
        { op: "tap", x: 0.5, y: 0.25 },
        { op: "touch", phase: "down", x: 0.2, y: 0.3 },
        { op: "touch", phase: "move", x: 0.4, y: 0.5 },
        { op: "touch", phase: "up", x: 0.4, y: 0.5 },
      ]);
      expect(managed.commands.some((args) => args[0] === "tap" || args[0] === "gesture")).toBe(
        false,
      );
    } finally {
      helpers.dispose();
    }
  });

  it("refuses input as disconnected when neither serve-sim nor the native helper can deliver it", async () => {
    const native = nativeHelpers();
    native.send.mockResolvedValue({
      status: "refused",
      code: "daemon-unresponsive",
      message: "no reply within 4 seconds",
    });
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: async () => "disconnected",
    });
    try {
      await expect(helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000)).resolves.toEqual({
        status: "refused",
        code: "input-disconnected",
        message:
          "Simulator input is disconnected. Repair input restarts the Simulator's home screen.",
      });
      await expect(helpers.send(udid, { op: "button", button: "home" }, 2_000)).resolves.toEqual(
        expect.objectContaining({ status: "refused", code: "input-disconnected" }),
      );
      expect(managed.commands.some((args) => args[0] === "tap" || args[0] === "button")).toBe(
        false,
      );
    } finally {
      helpers.dispose();
    }
  });

  it("still taps when the guest cannot say whether its input is connected", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: async () => "unknown",
    });
    try {
      await expect(helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000)).resolves.toEqual({
        status: "delivered",
      });
      expect(managed.commands).toContainEqual(["tap", "0.5", "0.25", "-d", udid]);
    } finally {
      helpers.dispose();
    }
  });

  it("repairs input through serve-sim and starts a fresh stream for the next tap", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await helpers.send(udid, { op: "hello" }, 2_000);
      await expect(helpers.send(udid, { op: "repair-input" }, 2_000)).resolves.toEqual({
        status: "delivered",
      });
      expect(managed.commands).toContainEqual(["repair-input", "-d", udid]);
      await helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000);
      expect(managed.commands.filter((args) => args.includes("--no-preview"))).toHaveLength(2);
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("refuses to repair input without the managed serve-sim tool", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(
      native,
      { launchSpec: async () => undefined, trackProcess: vi.fn() },
      { inputConnection: connected },
    );
    try {
      await expect(helpers.send(udid, { op: "repair-input" }, 1_000)).resolves.toEqual(
        expect.objectContaining({ status: "refused", code: "repair-unavailable" }),
      );
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("does not repeat a refused tap on the native helper", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(native, tools({ failTap: true }), {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await expect(helpers.send(udid, { op: "tap", x: 0.5, y: 0.25 }, 2_000)).resolves.toEqual({
        status: "unavailable",
        message: "The simulator stream did not accept the input.",
      });
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("lifts the finger when a swipe move does not reach the stream", async () => {
    const native = nativeHelpers();
    const managed = tools({ failGestureMove: true });
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await expect(
        helpers.send(
          udid,
          { op: "swipe", fromX: 0.2, fromY: 0.3, toX: 0.8, toY: 0.7, durationMs: 0 },
          2_000,
        ),
      ).resolves.toEqual({
        status: "unavailable",
        message: "The simulator stream did not accept the input.",
      });
      const gestures = managed.commands
        .filter((args) => args[0] === "gesture")
        .map((args) => JSON.parse(args[1] ?? "{}"));
      expect(gestures).toEqual([
        { type: "begin", x: 0.2, y: 0.3 },
        { type: "move", x: 0.8, y: 0.7 },
        { type: "end", x: 0.8, y: 0.7 },
      ]);
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("sends a key through the native helper while the stream is up", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(native, tools(), {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await helpers.send(udid, { op: "hello" }, 2_000);
      native.send.mockClear();
      await helpers.send(udid, { op: "key", key: "a" }, 1_000);
      expect(native.send).toHaveBeenCalledWith(udid, { op: "key", key: "a" }, 1_000, undefined);
    } finally {
      helpers.dispose();
    }
  });

  it("uses the native helper after the managed stream produces no frame", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const fetchNoFrame: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/config")) return new Response(JSON.stringify({ width: 100, height: 200 }));
      if (url.endsWith("/stream.mjpeg")) return new Response(new Uint8Array());
      return new Response("missing", { status: 404 });
    };
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchNoFrame,
      inputConnection: connected,
      firstFrameMs: 200,
    });
    try {
      await expect(
        helpers.watch(
          udid,
          { maxHeight: 100, quality: 0.5, framesPerSecond: 1 },
          { onFrame: () => undefined, onEnd: () => undefined },
          1_000,
        ),
      ).resolves.toEqual({ status: "unavailable", message: "native watch" });
      await helpers.send(udid, { op: "hello" }, 1_000);
      const launches = managed.commands.filter((args) => args.includes("--no-preview"));
      expect(launches).toHaveLength(2);
    } finally {
      helpers.dispose();
    }
  });

  it("keeps the native helper when the tool prints a non-loopback stream", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(native, tools({ badHost: true }), {
      fetch: fetchStream,
      inputConnection: connected,
    });
    try {
      await helpers.send(udid, { op: "hello" }, 2_000);
      expect(native.send).toHaveBeenCalledOnce();
    } finally {
      helpers.dispose();
    }
  });

  it("waits for serve-sim to report a screen size before using the stream", async () => {
    const native = nativeHelpers();
    let asked = 0;
    const fetchLate: typeof fetch = async (input) => {
      if (String(input).endsWith("/config")) {
        asked += 1;
        return new Response(
          JSON.stringify(asked < 3 ? { width: 0, height: 0 } : { width: 1206, height: 2622 }),
        );
      }
      return fetchStream(input);
    };
    const helpers = createManagedSimulatorHelpers(native, tools(), {
      fetch: fetchLate,
      inputConnection: connected,
    });
    try {
      await expect(helpers.send(udid, { op: "hello" }, 4_000)).resolves.toEqual({
        status: "delivered",
        screen: { width: 1206, height: 2622 },
      });
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });

  it("keys plain text through the native helper, not serve-sim", async () => {
    const native = nativeHelpers();
    const managed = tools();
    const copyToPasteboard = vi.fn(async () => true);
    const helpers = createManagedSimulatorHelpers(native, managed, {
      fetch: fetchStream,
      inputConnection: connected,
      copyToPasteboard,
    });
    try {
      await expect(helpers.send(udid, { op: "text", text: "Hello 42" }, 2_000)).resolves.toEqual({
        status: "delivered",
      });
      expect(native.send).toHaveBeenCalledWith(
        udid,
        { op: "text", text: "Hello 42" },
        2_000,
        undefined,
      );
      expect(copyToPasteboard).not.toHaveBeenCalled();
      expect(managed.commands.some((args) => args[0] === "type")).toBe(false);
    } finally {
      helpers.dispose();
    }
  });

  it("pastes punctuation and non-Latin text through the Simulator pasteboard", async () => {
    const native = nativeHelpers();
    const copyToPasteboard = vi.fn(async () => true);
    const helpers = createManagedSimulatorHelpers(native, tools(), {
      fetch: fetchStream,
      inputConnection: connected,
      copyToPasteboard,
    });
    try {
      await expect(
        helpers.send(udid, { op: "text", text: "héllo, wörld! 日本" }, 2_000),
      ).resolves.toEqual({ status: "delivered" });
      expect(copyToPasteboard).toHaveBeenCalledWith(udid, "héllo, wörld! 日本", expect.anything());
      expect(native.send).toHaveBeenCalledOnce();
      expect(native.send.mock.calls[0]?.[1]).toEqual({ op: "key", usage: 25, modifiers: [227] });
    } finally {
      helpers.dispose();
    }
  });

  it("presses nothing when the pasteboard cannot be set", async () => {
    const native = nativeHelpers();
    const helpers = createManagedSimulatorHelpers(native, tools(), {
      fetch: fetchStream,
      inputConnection: connected,
      copyToPasteboard: async () => false,
    });
    try {
      const reply = await helpers.send(udid, { op: "text", text: "a.b" }, 2_000);
      expect(reply.status).toBe("unavailable");
      expect(native.send).not.toHaveBeenCalled();
    } finally {
      helpers.dispose();
    }
  });
});

describe("Device Hub input notification", () => {
  it("reads Device Hub's takeover as disconnected and anything unexpected as unknown", () => {
    expect(readInputConnection("com.apple.coredevice.dtuhidd.active 1\n")).toBe("disconnected");
    expect(readInputConnection("com.apple.coredevice.dtuhidd.active 0\n")).toBe("connected");
    expect(readInputConnection("")).toBe("unknown");
    expect(readInputConnection("com.apple.coredevice.dtuhidd.active 17")).toBe("unknown");
  });
});
