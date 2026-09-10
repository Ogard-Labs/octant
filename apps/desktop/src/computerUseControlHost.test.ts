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
