import { describe, expect, it, vi } from "vitest";
import {
  decodeComputerUseOwner,
  decodeComputerControlCommand,
} from "@octant/contracts/computer-use-plugin";
import { createComputerUseControlHost } from "./computerUseControlHost";

const owner = decodeComputerUseOwner({
  windowId: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  mode: "code",
  providerInstanceId: "33333333-3333-4333-8333-333333333333",
  modelId: "fixture",
  executionPolicy: "approval-gated",
});

function fixture(protectedField = false, additionalElements = 0) {
  let snapshot = 0;
  const call = vi.fn(async (name: string) => {
    const data =
      name === "list_apps"
        ? { apps: [{ bundle_id: "com.example.Fixture", name: "Fixture", pid: 123, running: true }] }
        : name === "list_windows"
          ? { windows: [{ window_id: 9, title: "Fixture" }] }
          : name === "get_window_state"
            ? {
                snapshot_id: `s${String(++snapshot).padStart(8, "0")}`,
                screenshot_width: 100,
                screenshot_height: 100,
                elements: [
                  { element_index: 0, role: "AXWindow", label: "Fixture" },
                  {
                    element_index: 4,
                    role: protectedField ? "AXTextField" : "AXButton",
                    label: "Save",
                    parent_index: 0,
                    ...(protectedField
                      ? { value_description: "contains secure text", value: "masked" }
                      : {}),
                    frame: { x: 1, y: 1, w: 30, h: 20 },
                  },
                  { element_index: 5, role: "AXMenuBar", label: "Menu" },
                  {
                    element_index: 6,
                    parent_index: 5,
                    role: "AXMenuItem",
                    label: "System Settings",
                  },
                  ...Array.from({ length: additionalElements }, (_, index) => ({
                    element_index: index + 10,
                    parent_index: 0,
                    role: "AXButton",
                    label: "A long application label ".repeat(100),
                  })),
                ],
              }
            : { ok: true };
    return {
      text: "",
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
      structuredJson: JSON.stringify(data),
      rawJson: "{}",
      isError: false,
      degraded: false,
    };
  });
  const host = createComputerUseControlHost({
    runtime: async () => ({
      generation: "generation-1",
      version: "0.24.0",
      call,
      close: async () => {},
    }),
  });
  return { host, call };
}

describe("Thread-owned computer control", () => {
  it("bounds large accessibility observations to the provider tool-result budget", async () => {
    const { host } = fixture(false, 500);
    try {
      const result = await host.execute(
        owner,
        decodeComputerControlCommand({
          operation: "observe",
          appId: "com.example.Fixture",
          windowId: 9,
        }),
      );
      expect(result.kind).toBe("observation");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(48_000);
      if (result.kind === "observation") {
        expect(result.elements.length).toBeLessThanOrEqual(256);
        expect(result.truncated).toBe(true);
        expect(
          await host.execute(owner, {
            operation: "click",
            observationId: result.observationId,
            x: 10,
            y: 10,
          }),
        ).toMatchObject({ kind: "refused", reason: "incomplete-observation" });
      }
    } finally {
      await host.close();
    }
  });
  it("uses an observed element and returns fresh evidence after the action", async () => {
    const { host, call } = fixture();
    try {
      const observed = await host.execute(
        owner,
        decodeComputerControlCommand({
          operation: "observe",
          appId: "com.example.Fixture",
          windowId: 9,
        }),
      );
      if (observed.kind !== "observation") throw new Error("Expected a window observation.");
      expect(observed.elements.map((element) => element.index)).toEqual([0, 4]);
      const result = await host.execute(owner, {
        operation: "click",
        observationId: observed.observationId,
        elementIndex: 4,
      });
      expect(result.kind).toBe("observation");
      expect(call).toHaveBeenCalledWith(
        "click",
        expect.objectContaining({
          pid: 123,
          window_id: 9,
          element_index: 4,
          snapshot_id: "s00000002",
          delivery_mode: "background",
        }),
        expect.any(AbortSignal),
      );
      if (result.kind === "observation")
        expect(result.observationId).not.toBe(observed.observationId);
    } finally {
      await host.close();
    }
  });

  it("refuses another thread's observation and never shares a window lease", async () => {
    const { host, call } = fixture();
    try {
      const observed = await host.execute(
        owner,
        decodeComputerControlCommand({
          operation: "observe",
          appId: "com.example.Fixture",
          windowId: 9,
        }),
      );
      if (observed.kind !== "observation") throw new Error("Expected observation.");
      expect(observed.elements.find((element) => element.index === 4)?.value).toBeUndefined();
      const other = { ...owner, threadId: "44444444-4444-4444-8444-444444444444" };
      expect(
        await host.execute(other, {
          operation: "click",
          observationId: observed.observationId,
          elementIndex: 4,
        }),
      ).toMatchObject({ kind: "refused", reason: "stale-observation" });
      expect(
        await host.execute(
          other,
          decodeComputerControlCommand({
            operation: "observe",
            appId: "com.example.Fixture",
            windowId: 9,
          }),
        ),
      ).toMatchObject({ kind: "refused", reason: "window-owned" });
      expect(call.mock.calls.some(([name]) => name === "click")).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("refuses protected fields even after the app was approved", async () => {
    const { host, call } = fixture(true);
    try {
      const observed = await host.execute(
        owner,
        decodeComputerControlCommand({
          operation: "observe",
          appId: "com.example.Fixture",
          windowId: 9,
        }),
      );
      if (observed.kind !== "observation") throw new Error("Expected observation.");
      expect(
        await host.execute(owner, {
          operation: "type",
          observationId: observed.observationId,
          elementIndex: 4,
          text: "never delivered",
        }),
      ).toMatchObject({ kind: "refused", reason: "protected-field" });
      expect(call.mock.calls.some(([name]) => name === "type_text")).toBe(false);
    } finally {
      await host.close();
    }
  });
});

describe("Apple workbench input through Device Hub", () => {
  const command = { udid: "348B3796-90BE-4B03-ADC1-46D7468C9D43", name: "iPhone 17 Pro" };
  const deviceWindow = {
    window_id: 21487,
    pid: 65317,
    app_name: "Device Hub",
    title: "iPhone 17 Pro",
    bounds: { x: 1783, y: 774, width: 429, height: 929 },
    is_on_screen: true,
  };
  function deviceHubFixture(windowsPerCall: ReadonlyArray<ReadonlyArray<unknown>>) {
    let listing = 0;
    const call = vi.fn(async (name: string) => {
      const data =
        name === "list_windows"
          ? { windows: windowsPerCall[Math.min(listing++, windowsPerCall.length - 1)] }
          : name === "get_window_state"
            ? {
                snapshot_id: "s00000001",
                elements: [
                  {
                    element_index: 0,
                    role: "AXWindow",
                    label: "iPhone 17 Pro – iOS 27.0",
                    actions: [],
                  },
                  {
                    element_index: 4,
                    role: "AXButton",
                    label: "Generelt",
                    actions: ["AXPress"],
                    frame: { x: 1830.5, y: 1187.1, w: 335, h: 47.2 },
                  },
                  {
                    element_index: 29,
                    role: "AXButton",
                    label: "Home",
                    actions: ["AXPress"],
                    frame: { x: 1926, y: 1663, w: 32, h: 28 },
                  },
                ],
              }
            : { ok: true };
      return {
        text: "",
        images: [],
        structuredJson: JSON.stringify(data),
        rawJson: "{}",
        isError: false,
        degraded: false,
      };
    });
    const host = createComputerUseControlHost({
      runtime: async () => ({
        generation: "generation-1",
        version: "0.28.2",
        call,
        close: async () => {},
      }),
    });
    return { host, call };
  }
  const calls = (call: ReturnType<typeof vi.fn>) =>
    call.mock.calls.map(([name, args]) => [name, args] as const);

  it("types into the device window as key presses without opening a session or granting an app", async () => {
    const { host, call } = deviceHubFixture([[deviceWindow]]);
    try {
      const result = await host.simulatorInput({ kind: "type-text", ...command, text: "Hi 4" });
      expect(result).toEqual({
        kind: "delivered",
        detail: "4 key presses reached the iPhone 17 Pro window",
      });
      expect(
        calls(call)
          .filter(([name]) => name === "press_key")
          .map(([, args]) => args),
      ).toEqual([
        {
          pid: 65317,
          window_id: 21487,
          key: "h",
          modifiers: ["shift"],
          delivery_mode: "background",
        },
        { pid: 65317, window_id: 21487, key: "i", delivery_mode: "background" },
        { pid: 65317, window_id: 21487, key: "space", delivery_mode: "background" },
        { pid: 65317, window_id: 21487, key: "4", delivery_mode: "background" },
      ]);
      expect(calls(call).some(([name]) => name === "start_session" || name === "launch_app")).toBe(
        false,
      );
      expect(host.activeSessions()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("opens the device window through its URL when Device Hub shows none, then taps the element under a screenshot point", async () => {
    const { host, call } = deviceHubFixture([[], [], [deviceWindow]]);
    try {
      const result = await host.simulatorInput({
        kind: "tap",
        ...command,
        point: { x: 562, y: 1221 },
        frame: { width: 1206, height: 2622 },
      });
      expect(result).toEqual({ kind: "delivered", detail: "pressed «Generelt» (AXButton)" });
      expect(calls(call)).toContainEqual([
        "launch_app",
        {
          bundle_id: "com.apple.dt.Devices",
          urls: ["devices://device/open?id=348B3796-90BE-4B03-ADC1-46D7468C9D43"],
        },
      ]);
      expect(calls(call)).toContainEqual([
        "click",
        {
          pid: 65317,
          window_id: 21487,
          element_index: 4,
          snapshot_id: "s00000001",
          delivery_mode: "background",
        },
      ]);
    } finally {
      await host.close();
    }
  });

  it("refuses by name what Device Hub cannot deliver: unsupported characters, unknown keys, missing targets", async () => {
    const { host, call } = deviceHubFixture([[deviceWindow]]);
    try {
      expect(
        await host.simulatorInput({ kind: "type-text", ...command, text: "a@b" }),
      ).toMatchObject({
        kind: "refused",
        reason: "unsupported-characters",
      });
      expect(
        await host.simulatorInput({ kind: "key-press", ...command, key: "f13" }),
      ).toMatchObject({
        kind: "refused",
        reason: "unsupported-key",
      });
      expect(
        await host.simulatorInput({ kind: "tap", ...command, target: "Record" }),
      ).toMatchObject({
        kind: "refused",
        reason: "target-not-found",
      });
      expect(await host.simulatorInput({ kind: "key-press", ...command, key: "home" })).toEqual({
        kind: "delivered",
        detail: "pressed Device Hub's Home control",
      });
      expect(calls(call).filter(([name]) => name === "press_key")).toHaveLength(0);
    } finally {
      await host.close();
    }
  });
});
