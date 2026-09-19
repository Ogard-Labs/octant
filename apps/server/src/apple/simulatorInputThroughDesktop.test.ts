import { describe, expect, it, vi } from "vitest";
import type { AppleSimulatorRecord, AppleSimulatorRequest } from "@octant/contracts";
import { simulatorInputThroughDesktop } from "./simulatorInputThroughDesktop";
import type { AppleExecutionContext } from "./appleToolchainService";

const destination: AppleSimulatorRecord = {
  simulatorId: "348b3796-90be-4b03-adc1-46d7468c9d43" as never,
  name: "iPhone 17 Pro",
  platform: "ios",
  runtimeVersion: "27.0",
  state: "booted",
  udid: "348B3796-90BE-4B03-ADC1-46D7468C9D43",
};
const context = {} as AppleExecutionContext;
function request(
  fields: Partial<AppleSimulatorRequest> & { readonly kind: AppleSimulatorRequest["kind"] },
) {
  return {
    actionId: "10000000-0000-4000-8000-000000000001",
    correlationId: "10000000-0000-4000-8000-000000000002",
    authority: {
      hostId: "host",
      mode: "code",
      projectId: "p",
      providerInstanceId: "i",
      extension: { kind: "core" },
    },
    threadId: "10000000-0000-4000-8000-000000000003",
    checkoutId: "10000000-0000-4000-8000-000000000004",
    simulatorId: destination.simulatorId,
    timeoutMs: 10_000,
    approval: { kind: "not-required" },
    ...fields,
  } as unknown as AppleSimulatorRequest;
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("Simulator input through the desktop broker", () => {
  it("delivers a pane tap with the screenshot it was read from and reads as a succeeded process", async () => {
    const simulatorInput = vi.fn(async () => ({
      kind: "delivered" as const,
      detail: "pressed «Generelt» (AXButton)",
    }));
    const inject = simulatorInputThroughDesktop({ simulatorInput });
    const result = await inject(
      request({ kind: "tap", point: { x: 562, y: 1221, frameWidth: 1206, frameHeight: 2622 } }),
      context,
      10_000,
      undefined,
      destination,
    );
    expect(simulatorInput).toHaveBeenCalledWith(
      {
        kind: "tap",
        udid: destination.udid,
        name: "iPhone 17 Pro",
        point: { x: 562, y: 1221 },
        frame: { width: 1206, height: 2622 },
      },
      undefined,
    );
    expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
    expect(text(result.stdout)).toBe("pressed «Generelt» (AXButton)");
  });

  it("names the desktop's refusal as a failed process instead of an interrupted one", async () => {
    const inject = simulatorInputThroughDesktop({
      simulatorInput: async () => ({
        kind: "refused",
        reason: "unsupported-characters",
        message:
          "Device Hub keyboard delivery covers letters, digits, space and newline; «@» cannot be typed yet.",
      }),
    });
    const result = await inject(
      request({ kind: "type-text", text: "a@b" }),
      context,
      10_000,
      undefined,
      destination,
    );
    expect(result).toMatchObject({ termination: "exited", exitCode: 1 });
    expect(text(result.stderr)).toMatch(/^unsupported-characters: /);
  });

  it("hands typed text its action deadline so the desktop can refuse what cannot fit", async () => {
    const simulatorInput = vi.fn(async () => ({ kind: "delivered" as const, detail: "ok" }));
    const inject = simulatorInputThroughDesktop({ simulatorInput });
    await inject(
      request({ kind: "type-text", text: "hello" }),
      context,
      37_500,
      undefined,
      destination,
    );
    expect(simulatorInput).toHaveBeenCalledWith(
      {
        kind: "type-text",
        udid: destination.udid,
        name: "iPhone 17 Pro",
        text: "hello",
        budgetMs: 37_500,
      },
      undefined,
    );
  });

  it("refuses a coordinate tap without its frame and a request for an undiscovered destination without calling the desktop", async () => {
    const simulatorInput = vi.fn();
    const inject = simulatorInputThroughDesktop({ simulatorInput });
    const noFrame = await inject(
      request({ kind: "tap", point: { x: 1, y: 1 } }),
      context,
      10_000,
      undefined,
      destination,
    );
    expect(noFrame.termination).toBe("unavailable");
    expect(text(noFrame.stderr)).toMatch(/size of the screenshot/);
    const noDestination = await inject(
      request({ kind: "key-press", key: "return" }),
      context,
      10_000,
      undefined,
      undefined,
    );
    expect(noDestination.termination).toBe("unavailable");
    expect(simulatorInput).not.toHaveBeenCalled();
  });

  it("reads an unreachable broker as unavailable rather than as a device failure", async () => {
    const inject = simulatorInputThroughDesktop({
      simulatorInput: async () => {
        throw new Error("Computer-use desktop connection is unavailable.");
      },
    });
    const result = await inject(
      request({ kind: "key-press", key: "return" }),
      context,
      10_000,
      undefined,
      destination,
    );
    expect(result.termination).toBe("unavailable");
    expect(text(result.stderr)).toMatch(/desktop app/);
  });
});
