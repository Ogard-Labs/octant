import { describe, expect, it, vi } from "vitest";
import type { SimulatorDeviceInput } from "@octant/contracts/simulator-device";
import {
  createSimulatorInputDelivery,
  simulatorDeviceBrokerHandler,
} from "./simulatorDeviceBroker";
import type {
  DeviceHelperReply,
  DeviceHelperRequest,
  SimulatorDeviceHelpers,
} from "./simulatorDeviceHelper";

const token = "a".repeat(43);
const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";

function helpers(answer: (request: DeviceHelperRequest) => DeviceHelperReply) {
  const send = vi.fn(
    async (_simulatorId: string, request: DeviceHelperRequest, _timeoutMs: number) =>
      answer(request),
  );
  const fake: SimulatorDeviceHelpers = { send, busy: () => false, dispose: vi.fn() };
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
