import { describe, expect, it, vi } from "vitest";
import { probeComputerUse } from "./computerUseProbe";
import type { ComputerDriverRuntime } from "./computerUseSdkRuntime";

function fixture() {
  const image = { mimeType: "image/png", dataBase64: "aW1hZ2U=" };
  const snapshot = {
    snapshot_id: "s01234567",
    elements: [
      { element_index: 0, role: "AXWindow" },
      { element_index: 1, parent_index: 0, role: "AXButton", label: "Test fixture" },
    ],
  };
  const call = vi.fn(async (_name: string, _args: Readonly<Record<string, unknown>>) => ({
    isError: false,
    degraded: false,
    rawJson: "{}",
    text: "",
    images: [image],
    structuredJson: JSON.stringify(snapshot),
  }));
  const runtime: ComputerDriverRuntime = {
    generation: "test",
    version: "0.38.0",
    call,
    close: vi.fn(async () => {}),
  };
  const target = {
    windowId: 42,
    buttonLabel: "Test fixture",
    isOpen: () => true,
    wasClicked: vi.fn(async () => true),
  };
  return { runtime, call, target, snapshot, image };
}

describe("Computer use setup diagnostic", () => {
  it("captures only the owned window, clicks its observed button and verifies the result", async () => {
    const { runtime, call, target } = fixture();
    await probeComputerUse(runtime, target, new AbortController().signal);
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "get_window_state",
      "start_session",
      "click",
      "end_session",
    ]);
    expect(call).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({
        pid: process.pid,
        window_id: 42,
        element_token: "s01234567:1",
        delivery_mode: "background",
      }),
      expect.any(AbortSignal),
    );
    expect(target.wasClicked).toHaveBeenCalledOnce();
  });
  it("refuses a capture without pixels and never clicks", async () => {
    const { runtime, call, target, snapshot } = fixture();
    call.mockResolvedValue({
      isError: false,
      degraded: false,
      rawJson: "{}",
      text: "",
      images: [],
      structuredJson: JSON.stringify(snapshot),
    });
    await expect(probeComputerUse(runtime, target, new AbortController().signal)).rejects.toThrow(
      /captured/,
    );
    expect(call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "end_session"]);
  });
  it("refuses a similarly named control outside the window tree", async () => {
    const { runtime, call, target, snapshot } = fixture();
    snapshot.elements[1] = {
      element_index: 1,
      parent_index: 999,
      role: "AXButton",
      label: "Test fixture",
    };
    await expect(probeComputerUse(runtime, target, new AbortController().signal)).rejects.toThrow(
      /test button/,
    );
    expect(call.mock.calls.some(([name]) => name === "click")).toBe(false);
  });
  it("does not report success when the click produced no verified change", async () => {
    const { runtime, call, target } = fixture();
    target.wasClicked.mockResolvedValue(false);
    await expect(probeComputerUse(runtime, target, new AbortController().signal)).rejects.toThrow(
      /verify the test click/,
    );
    expect(call.mock.calls.at(-1)?.[0]).toBe("end_session");
  });
  it("stops before input when the window closes or the person cancels", async () => {
    const { runtime, call, target } = fixture();
    const abort = new AbortController();
    target.isOpen = () => {
      abort.abort();
      return false;
    };
    await expect(probeComputerUse(runtime, target, abort.signal)).rejects.toThrow();
    expect(call.mock.calls.map(([name]) => name)).toEqual(["end_session"]);
  });
});
