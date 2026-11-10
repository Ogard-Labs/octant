import { randomUUID } from "node:crypto";
import type { ComputerDriverRuntime } from "./computerUseSdkRuntime";

/** Only the local setup window creates this target; no renderer supplies an address. */
export interface ComputerUseProbeWindow {
  readonly windowId: number;
  readonly buttonLabel: string;
  readonly isOpen: () => boolean;
  readonly wasClicked: () => Promise<boolean>;
}

export async function probeComputerUse(
  runtime: ComputerDriverRuntime,
  target: ComputerUseProbeWindow,
  signal: AbortSignal,
): Promise<void> {
  const session = `octant-setup-${randomUUID()}`;
  const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
    signal.throwIfAborted();
    if (!target.isOpen()) throw new Error("The test window was closed. Run the test again.");
    const result = await runtime.call(name, args, signal);
    if (result.isError)
      throw new Error("The driver could not complete the test. Recheck permissions and retry.");
    return result;
  };
  try {
    const response = await call("get_window_state", {
      pid: process.pid,
      window_id: target.windowId,
      include_screenshot: true,
      tree_format: "elements",
      max_dimension: 640,
      max_elements: 64,
    });
    if (!response.images.some((image) => image.dataBase64.length > 0))
      throw new Error(
        "The test window could not be captured. Check Screen Recording and relaunch Octant.",
      );
    const snapshot: unknown = JSON.parse(response.structuredJson ?? "null");
    if (
      !record(snapshot) ||
      typeof snapshot.snapshot_id !== "string" ||
      !/^s[0-9a-f]{8}$/.test(snapshot.snapshot_id) ||
      !Array.isArray(snapshot.elements)
    )
      throw new Error(
        "The driver could not read the test controls. Check Accessibility and relaunch Octant.",
      );
    const elements = snapshot.elements.filter(record);
    const root = elements.find(
      (element) => element.role === "AXWindow" && element.parent_index === undefined,
    );
    const descendants = new Set<unknown>(root === undefined ? [] : [root.element_index]);
    const buttons = elements.filter((element) => {
      if (!descendants.has(element.parent_index)) return false;
      descendants.add(element.element_index);
      return element.role === "AXButton" && element.label === target.buttonLabel;
    });
    const button = buttons[0];
    if (buttons.length !== 1 || button === undefined || !Number.isSafeInteger(button.element_index))
      throw new Error(
        "The test button was not available through Accessibility. Relaunch Octant and retry.",
      );
    await call("start_session", { session });
    await call("click", {
      pid: process.pid,
      window_id: target.windowId,
      session,
      delivery_mode: "background",
      element_token: `${snapshot.snapshot_id}:${button.element_index}`,
    });
    signal.throwIfAborted();
    if (!target.isOpen() || !(await target.wasClicked()))
      throw new Error(
        "The driver could not verify the test click. Recheck Accessibility and retry.",
      );
  } finally {
    // Cleanup has its own deadline even after cancellation of the test.
    await runtime
      .call("end_session", { session }, AbortSignal.timeout(3_000))
      .catch(() => undefined);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
