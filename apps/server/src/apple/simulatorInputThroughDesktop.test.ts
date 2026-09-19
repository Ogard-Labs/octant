import { describe, expect, it, vi } from "vitest";
import type { AppleSimulatorRequest } from "@octant/contracts";
import type {
  SimulatorDeviceInput,
  SimulatorDeviceInputResult,
} from "@octant/contracts/simulator-device";
import type { AppleExecutionContext } from "./appleToolchainService";
import { createDesktopSimulatorDevicePort } from "./desktopSimulatorDevicePort";
import { simulatorInputThroughDesktop } from "./simulatorInputThroughDesktop";

const udid = "7E29846E-F920-438E-8AB2-930C1A0F7FB7";
const context = {} as AppleExecutionContext;
const request = (overrides: Partial<AppleSimulatorRequest>) =>
  ({ simulatorId: udid, timeoutMs: 30_000, ...overrides }) as AppleSimulatorRequest;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function desktop(result: SimulatorDeviceInputResult) {
  const deliver = vi.fn(async (_input: SimulatorDeviceInput, _signal?: AbortSignal) => result);
  return { deliver, inject: simulatorInputThroughDesktop({ deliver }) };
}

describe("Simulator input through the desktop's device helper", () => {
  it("sends a tap as the point on the captured screen, bound to the Simulator and the deadline", async () => {
    const { deliver, inject } = desktop({ kind: "delivered" });

    const result = await inject(
      request({ kind: "tap", point: { x: 603, y: 1311 } }),
      context,
      30_000,
    );

    expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
    expect(deliver.mock.calls[0]?.[0]).toEqual({
      kind: "tap",
      udid,
      budgetMs: 30_000,
      point: { x: 603, y: 1311 },
    });
  });

  it("sends a swipe with both ends and a default pace when none was asked for", async () => {
    const { deliver, inject } = desktop({ kind: "delivered" });

    await inject(
      request({ kind: "swipe", point: { x: 600, y: 2_000 }, toPoint: { x: 600, y: 800 } }),
      context,
      30_000,
    );

    expect(deliver.mock.calls[0]?.[0]).toEqual({
      kind: "swipe",
      udid,
      budgetMs: 30_000,
      from: { x: 600, y: 2_000 },
      to: { x: 600, y: 800 },
      durationMs: 250,
    });
  });

  it("sends typed text and keys, and never echoes the text back", async () => {
    const { deliver, inject } = desktop({ kind: "delivered" });

    const typed = await inject(request({ kind: "type-text", text: "hunter2" }), context, 30_000);
    await inject(request({ kind: "key-press", key: "return" }), context, 30_000);

    expect(text(typed.stdout) + text(typed.stderr)).not.toContain("hunter2");
    expect(deliver.mock.calls.map(([input]) => input.kind)).toEqual(["type-text", "key-press"]);
  });

  it("reports the helper's refusal as a failed action that names the reason", async () => {
    const { inject } = desktop({
      kind: "refused",
      reason: "not-booted",
      message: "the Simulator is Shutdown",
    });

    const result = await inject(request({ kind: "key-press", key: "home" }), context, 30_000);

    expect(result).toMatchObject({ termination: "exited", exitCode: 1 });
    expect(text(result.stderr)).toBe("not-booted: the Simulator is Shutdown");
  });

  it("reports a helper that never answered, or a desktop that is gone, as unavailable", async () => {
    const silent = desktop({
      kind: "unavailable",
      reason: "helper-unavailable",
      message: "The device helper did not answer in time.",
    });
    expect(
      await silent.inject(request({ kind: "key-press", key: "home" }), context, 30_000),
    ).toMatchObject({ termination: "unavailable", exitCode: null });

    const gone = simulatorInputThroughDesktop({
      deliver: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const result = await gone(request({ kind: "key-press", key: "home" }), context, 30_000);
    expect(result.termination).toBe("unavailable");
    expect(text(result.stderr)).toContain("desktop app");
  });

  it("says a tap by element name is not something the helper can do, without calling it", async () => {
    const { deliver, inject } = desktop({ kind: "delivered" });

    const result = await inject(request({ kind: "tap", target: "Sign in" }), context, 30_000);

    expect(result.termination).toBe("unavailable");
    expect(text(result.stderr)).toContain("cannot find an element by name");
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("the server's port to the desktop device broker", () => {
  const token = "t".repeat(43);
  const environment = {
    OCTANT_SIMULATOR_DEVICE_BROKER_URL: "http://127.0.0.1:43000/v1/simulator-device",
    OCTANT_SIMULATOR_DEVICE_BROKER_TOKEN: token,
  };

  it("exists only for a loopback broker address and a well-formed token", () => {
    expect(createDesktopSimulatorDevicePort({})).toBeUndefined();
    expect(
      createDesktopSimulatorDevicePort({
        ...environment,
        OCTANT_SIMULATOR_DEVICE_BROKER_URL: "http://example.test/v1/simulator-device",
      }),
    ).toBeUndefined();
    expect(
      createDesktopSimulatorDevicePort({
        ...environment,
        OCTANT_SIMULATOR_DEVICE_BROKER_TOKEN: "short",
      }),
    ).toBeUndefined();
    expect(createDesktopSimulatorDevicePort(environment)).toBeDefined();
  });

  it("posts the input with the broker token and decodes the result", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ kind: "delivered" }),
    );
    const port = createDesktopSimulatorDevicePort(
      environment,
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      port?.deliver({ kind: "key-press", udid, budgetMs: 30_000, key: "home" }),
    ).resolves.toEqual({ kind: "delivered" });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(environment.OCTANT_SIMULATOR_DEVICE_BROKER_URL);
    expect(new Headers(init?.headers).get("x-octant-simulator-device-token")).toBe(token);
    expect(JSON.parse(String(init?.body))).toEqual({
      input: { kind: "key-press", udid, budgetMs: 30_000, key: "home" },
    });
  });

  it("opens the screen stream, reading the screen's size from the broker's header", async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(Uint8Array.from([0, 0, 0, 1, 0xff]), {
          status: 200,
          headers: { "x-octant-simulator-screen": "1206x2622" },
        }),
    );
    const port = createDesktopSimulatorDevicePort(
      environment,
      fetchImpl as unknown as typeof fetch,
    );

    const watch = await port?.watch({ udid, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${environment.OCTANT_SIMULATOR_DEVICE_BROKER_URL}/stream`,
    );
    expect(watch?.kind).toBe("watching");
    if (watch?.kind !== "watching") return;
    expect(watch.screen).toEqual({ width: 1206, height: 2622 });
    expect([...new Uint8Array(await new Response(watch.frames).arrayBuffer())]).toEqual([
      0, 0, 0, 1, 0xff,
    ]);
  });

  it("returns the helper's reason when a Simulator cannot be watched", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { kind: "refused", reason: "not-booted", message: "the Simulator is Shutdown" },
        { status: 409 },
      ),
    );
    const port = createDesktopSimulatorDevicePort(
      environment,
      fetchImpl as unknown as typeof fetch,
    );

    await expect(
      port?.watch({ udid, maxHeight: 1_100, quality: 0.7, framesPerSecond: 30 }),
    ).resolves.toEqual({
      kind: "refused",
      reason: "not-booted",
      message: "the Simulator is Shutdown",
    });
  });
});
