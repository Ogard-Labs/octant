import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorDeviceInput } from "@octant/contracts/simulator-device";
import {
  createSimulatorInputDelivery,
  createSimulatorScreenStream,
  simulatorDeviceBrokerHandler,
} from "./simulatorDeviceBroker";
import type {
  DeviceHelperReply,
  DeviceHelperRequest,
  DeviceViewer,
  DeviceWatch,
  SimulatorDeviceHelpers,
} from "./simulatorDeviceHelper";

const token = "a".repeat(43);
const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";

function helpers(answer: (request: DeviceHelperRequest) => DeviceHelperReply) {
  const send = vi.fn(
    async (_simulatorId: string, request: DeviceHelperRequest, _timeoutMs: number) =>
      answer(request),
  );
  const fake: SimulatorDeviceHelpers = {
    send,
    watch: vi.fn(
      async (): Promise<DeviceWatch> => ({ status: "unavailable", message: "not under test" }),
    ),
    busy: () => false,
    dispose: vi.fn(),
  };
  return { fake, send };
}

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("http://127.0.0.1/v1/simulator-device", {
    method: "POST",
    headers: { "x-octant-simulator-device-token": token, ...headers },
    body: JSON.stringify(body),
  });
}

describe("Simulator input delivery", () => {
  it("turns a point on a capture into a fraction of the screen the helper reports", async () => {
    const { fake, send } = helpers((sent) =>
      sent.op === "hello"
        ? { status: "delivered", screen: { width: 1206, height: 2622 } }
        : { status: "delivered" },
    );
    const deliver = createSimulatorInputDelivery(fake);

    await expect(
      deliver({ kind: "tap", udid, budgetMs: 30_000, point: { x: 603, y: 1311 } }),
    ).resolves.toEqual({ kind: "delivered" });
    await deliver({ kind: "tap", udid, budgetMs: 30_000, point: { x: 0, y: 2622 } });

    // The screen is asked for once per Simulator, not once per tap.
    expect(send.mock.calls.map(([, sent]) => sent)).toEqual([
      { op: "hello" },
      { op: "tap", x: 0.5, y: 0.5 },
      { op: "tap", x: 0, y: 1 },
    ]);
  });

  it("gives a first tap one deadline, not a fresh one for each step", async () => {
    let clock = 0;
    const { fake, send } = helpers((sent) => {
      // Asking a cold Simulator service for the screen takes most of the budget.
      if (sent.op === "hello") {
        clock += 20_000;
        return { status: "delivered", screen: { width: 1206, height: 2622 } };
      }
      return { status: "delivered" };
    });
    const deliver = createSimulatorInputDelivery(fake, { now: () => clock });

    await deliver({ kind: "tap", udid, budgetMs: 30_000, point: { x: 10, y: 10 } });

    expect(send.mock.calls.map(([, sent, timeoutMs]) => [sent.op, timeoutMs])).toEqual([
      ["hello", 28_000],
      ["tap", 8_000],
    ]);
  });

  it("does not tap at all once the deadline has passed while it was getting ready", async () => {
    let clock = 0;
    const { fake, send } = helpers((sent) => {
      if (sent.op === "hello") clock += 29_000;
      return { status: "delivered", screen: { width: 1206, height: 2622 } };
    });
    const deliver = createSimulatorInputDelivery(fake, { now: () => clock });

    await expect(
      deliver({ kind: "tap", udid, budgetMs: 30_000, point: { x: 10, y: 10 } }),
    ).resolves.toMatchObject({ kind: "unavailable", reason: "deadline-passed" });
    expect(send.mock.calls.map(([, sent]) => sent.op)).toEqual(["hello"]);
  });

  it("refuses a point that is not on the screen instead of tapping its edge", async () => {
    const { fake, send } = helpers(() => ({
      status: "delivered",
      screen: { width: 1206, height: 2622 },
    }));
    const deliver = createSimulatorInputDelivery(fake);

    await expect(
      deliver({ kind: "tap", udid, budgetMs: 30_000, point: { x: 1300, y: 10 } }),
    ).resolves.toMatchObject({ kind: "refused", reason: "point-off-screen" });
    expect(send.mock.calls.map(([, sent]) => sent.op)).toEqual(["hello"]);
  });

  it("sends a swipe as two fractions of the screen and refuses one that leaves it", async () => {
    const { fake, send } = helpers((sent) =>
      sent.op === "hello"
        ? { status: "delivered", screen: { width: 1206, height: 2622 } }
        : { status: "delivered" },
    );
    const deliver = createSimulatorInputDelivery(fake);

    await expect(
      deliver({
        kind: "swipe",
        udid,
        budgetMs: 30_000,
        from: { x: 603, y: 2_622 },
        to: { x: 603, y: 1_311 },
        durationMs: 250,
      }),
    ).resolves.toEqual({ kind: "delivered" });
    await expect(
      deliver({
        kind: "swipe",
        udid,
        budgetMs: 30_000,
        from: { x: 603, y: 100 },
        to: { x: 3_000, y: 100 },
        durationMs: 250,
      }),
    ).resolves.toMatchObject({ kind: "refused", reason: "point-off-screen" });

    expect(send.mock.calls.map(([, sent]) => sent)).toEqual([
      { op: "hello" },
      { op: "swipe", fromX: 0.5, fromY: 1, toX: 0.5, toY: 0.5, durationMs: 250 },
    ]);
  });

  it("presses Home and Lock as hardware buttons and every other name as a key", async () => {
    const { fake, send } = helpers(() => ({ status: "delivered" }));
    const deliver = createSimulatorInputDelivery(fake);

    await deliver({ kind: "key-press", udid, budgetMs: 30_000, key: "Home" });
    await deliver({ kind: "key-press", udid, budgetMs: 30_000, key: "return" });
    await deliver({ kind: "type-text", udid, budgetMs: 30_000, text: "Octant 42" });

    expect(send.mock.calls.map(([, sent]) => sent)).toEqual([
      { op: "button", button: "home" },
      { op: "key", key: "return" },
      { op: "text", text: "Octant 42" },
    ]);
  });

  it("answers inside the action's deadline so the server hears the helper's own reason", async () => {
    const { fake, send } = helpers(() => ({ status: "delivered" }));
    await createSimulatorInputDelivery(fake)({
      kind: "key-press",
      udid,
      budgetMs: 30_000,
      key: "return",
    });
    expect(send.mock.calls[0]?.[2]).toBe(28_000);
  });

  it("refuses a deadline too short to answer inside, rather than taking longer than it was given", async () => {
    const { fake, send } = helpers(() => ({ status: "delivered" }));

    await expect(
      createSimulatorInputDelivery(fake)({ kind: "key-press", udid, budgetMs: 1_500, key: "home" }),
    ).resolves.toMatchObject({ kind: "unavailable", reason: "deadline-too-short" });
    expect(send).not.toHaveBeenCalled();
  });

  it("tells a helper's refusal from a helper that never answered", async () => {
    const refusing = helpers(() => ({
      status: "refused",
      code: "not-booted",
      message: "the Simulator is Shutdown",
    }));
    await expect(
      createSimulatorInputDelivery(refusing.fake)({
        kind: "type-text",
        udid,
        budgetMs: 30_000,
        text: "a",
      }),
    ).resolves.toEqual({
      kind: "refused",
      reason: "not-booted",
      message: "the Simulator is Shutdown",
    });
    const silent = helpers(() => ({
      status: "unavailable",
      message: "The device helper did not answer in time.",
    }));
    await expect(
      createSimulatorInputDelivery(silent.fake)({
        kind: "type-text",
        udid,
        budgetMs: 30_000,
        text: "a",
      }),
    ).resolves.toMatchObject({ kind: "unavailable", reason: "helper-unavailable" });
  });
});

describe("private Simulator device broker", () => {
  it("refuses browser, remote, unauthenticated and malformed calls before any input", async () => {
    const deliver = vi.fn(async (_input: SimulatorDeviceInput) => ({ kind: "delivered" as const }));
    const handle = simulatorDeviceBrokerHandler(deliver, token);
    const input = { kind: "key-press", udid, budgetMs: 30_000, key: "home" };

    expect((await handle(request({ input }), "10.0.0.8")).status).toBe(401);
    expect((await handle(request({ input }, { origin: "https://example.test" }))).status).toBe(401);
    expect(
      (await handle(request({ input }, { "x-octant-simulator-device-token": "b".repeat(43) })))
        .status,
    ).toBe(401);
    expect((await handle(request({ input: { ...input, udid: "--set /tmp" } }))).status).toBe(400);
    expect((await handle(request({ nothing: true }))).status).toBe(400);
    expect(
      (
        await handle(
          new Request("http://127.0.0.1/v1/simulator-device?x=1", {
            method: "POST",
            headers: { "x-octant-simulator-device-token": token },
            body: JSON.stringify({ input }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers a well-formed input from the desktop's own server and returns the result", async () => {
    const deliver = vi.fn(async (_input: SimulatorDeviceInput) => ({ kind: "delivered" as const }));
    const handle = simulatorDeviceBrokerHandler(deliver, token);

    const response = await handle(
      request({ input: { kind: "key-press", udid, budgetMs: 30_000, key: "home" } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "delivered" });
    expect(deliver).toHaveBeenCalledWith({
      kind: "key-press",
      udid,
      budgetMs: 30_000,
      key: "home",
    });
  });
});

describe("the Simulator screen stream", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(fake: SimulatorDeviceHelpers) {
    const stream = createSimulatorScreenStream(fake);
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        void stream(JSON.parse(Buffer.concat(chunks).toString("utf8")), outgoing);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  function watchable() {
    let viewer: DeviceViewer | undefined;
    const stop = vi.fn();
    const { fake } = helpers(() => ({
      status: "delivered",
      screen: { width: 1206, height: 2622 },
    }));
    const watching: SimulatorDeviceHelpers = {
      ...fake,
      watch: vi.fn(async (_udid, _options, next): Promise<DeviceWatch> => {
        viewer = next;
        // The helper's first frame arrives before the answer's headers exist.
        next.onFrame(Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
        return { status: "watching", stop };
      }),
    };
    return { watching, stop, frame: (bytes: number[]) => viewer?.onFrame(Uint8Array.from(bytes)) };
  }

  const watch = { udid, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 };

  async function readBytes(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
    let bytes = Buffer.alloc(0);
    while (bytes.length < count) {
      const next = await reader.read();
      if (next.done) break;
      bytes = Buffer.concat([bytes, next.value]);
    }
    return [...bytes];
  }

  it("names the screen's size, sends the first screen at once, then each frame behind its length", async () => {
    const { watching, frame } = watchable();
    const url = await serve(watching);
    const abort = new AbortController();

    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ watch }),
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-octant-simulator-screen")).toBe("1206x2622");
    const reader = response.body!.getReader();
    expect(await readBytes(reader, 9)).toEqual([0, 0, 0, 5, 0xff, 0xd8, 0x01, 0xff, 0xd9]);

    frame([0xff, 0xd8, 0x02, 0x03, 0xff, 0xd9]);
    expect(await readBytes(reader, 10)).toEqual([0, 0, 0, 6, 0xff, 0xd8, 0x02, 0x03, 0xff, 0xd9]);
    abort.abort();
  });

  it("stops watching when the viewer hangs up", async () => {
    const { watching, stop } = watchable();
    const url = await serve(watching);
    const abort = new AbortController();
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ watch }),
      signal: abort.signal,
    });
    await response.body!.getReader().read();

    abort.abort();

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("starts no watch for a viewer who hung up while the screen was still being looked up", async () => {
    let answerHello!: (reply: DeviceHelperReply) => void;
    const watch = vi.fn(async (): Promise<DeviceWatch> => ({ status: "watching", stop: vi.fn() }));
    const slow: SimulatorDeviceHelpers = {
      send: vi.fn(
        () =>
          new Promise<DeviceHelperReply>((resolve) => {
            answerHello = resolve;
          }),
      ),
      watch,
      busy: () => false,
      dispose: vi.fn(),
    };
    const url = await serve(slow);
    const abort = new AbortController();
    const pending = fetch(url, {
      method: "POST",
      body: JSON.stringify({
        watch: { udid, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 },
      }),
      signal: abort.signal,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(slow.send).toHaveBeenCalled());

    abort.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
    answerHello({ status: "delivered", screen: { width: 1206, height: 2622 } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(watch).not.toHaveBeenCalled();
  });

  it("answers a Simulator that cannot be watched with the helper's reason, not an empty stream", async () => {
    const { fake } = helpers((sent) =>
      sent.op === "hello"
        ? { status: "refused", code: "not-booted", message: "the Simulator is Shutdown" }
        : { status: "delivered" },
    );
    const url = await serve(fake);

    const response = await fetch(url, { method: "POST", body: JSON.stringify({ watch }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      kind: "refused",
      reason: "not-booted",
      message: "the Simulator is Shutdown",
    });
    expect(fake.watch).not.toHaveBeenCalled();
  });

  it("refuses a malformed watch request", async () => {
    const { watching } = watchable();
    const url = await serve(watching);

    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ watch: { ...watch, framesPerSecond: 1_000 } }),
    });

    expect(response.status).toBe(400);
    expect(watching.watch).not.toHaveBeenCalled();
  });
});
