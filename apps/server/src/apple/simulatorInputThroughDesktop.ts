import type { AppleSimulatorRequest } from "@octant/contracts";
import type { SimulatorDeviceInput } from "@octant/contracts/simulator-device";
import type { AppleProcessResult, AppleToolchainServiceOptions } from "./appleToolchainService";
import type { DesktopSimulatorDevicePort } from "./desktopSimulatorDevicePort";

type InjectSimulatorInput = NonNullable<AppleToolchainServiceOptions["injectSimulatorInput"]>;

/**
 * Simulator input delivered by the desktop's native device helper. The result
 * is shaped like a host process so workbench evidence names a refusal the same
 * way it names a failed `simctl` call, and a desktop that cannot be reached
 * reads as unavailable rather than failed.
 */
export function simulatorInputThroughDesktop(
  desktop: Pick<DesktopSimulatorDevicePort, "deliver">,
): InjectSimulatorInput {
  return async (request, _context, timeoutMs, signal) => {
    const input = simulatorDeviceInput(request, timeoutMs);
    if (input.kind === "unavailable") return unavailable(input.message);
    try {
      const result = await desktop.deliver(input.input, signal);
      if (result.kind === "delivered") return exited(0, "");
      return result.kind === "refused"
        ? exited(1, `${result.reason}: ${result.message}`)
        : unavailable(`${result.reason}: ${result.message}`);
    } catch {
      return unavailable(
        "Octant's desktop app could not be reached; Simulator input needs the desktop app.",
      );
    }
  };
}

export function simulatorDeviceInput(
  request: AppleSimulatorRequest,
  timeoutMs: number,
):
  | { readonly kind: "input"; readonly input: SimulatorDeviceInput }
  | { readonly kind: "unavailable"; readonly message: string } {
  if (request.simulatorId === undefined) {
    return { kind: "unavailable", message: "Simulator input names no destination." };
  }
  // A Simulator's identifier is its device UDID; `simctl` is already given it.
  const destination = { udid: String(request.simulatorId), budgetMs: timeoutMs };
  if (request.kind === "type-text" && request.text !== undefined) {
    return { kind: "input", input: { kind: "type-text", ...destination, text: request.text } };
  }
  if (request.kind === "key-press" && request.key !== undefined) {
    return { kind: "input", input: { kind: "key-press", ...destination, key: request.key } };
  }
  if (request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined) {
    const ends = [request.point, request.toPoint];
    if (ends.some((end) => end.x < 0 || end.y < 0)) {
      return { kind: "unavailable", message: "The swipe leaves the captured screen." };
    }
    return {
      kind: "input",
      input: {
        kind: "swipe",
        ...destination,
        from: { x: request.point.x, y: request.point.y },
        to: { x: request.toPoint.x, y: request.toPoint.y },
        // The pace of a finger flicking a list; slower reads as a drag.
        durationMs: request.durationMs ?? 250,
      },
    };
  }
  if (request.kind === "tap" && request.point !== undefined) {
    if (request.point.x < 0 || request.point.y < 0) {
      return { kind: "unavailable", message: "The tap point is off the captured screen." };
    }
    return {
      kind: "input",
      input: { kind: "tap", ...destination, point: { x: request.point.x, y: request.point.y } },
    };
  }
  if (request.kind === "tap" && request.target !== undefined) {
    return {
      kind: "unavailable",
      message:
        "The device helper taps a point on a captured screen; it cannot find an element by name yet.",
    };
  }
  return { kind: "unavailable", message: "Simulator input request is incomplete." };
}

function exited(exitCode: number, stderr: string): AppleProcessResult {
  return {
    termination: "exited",
    exitCode,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(stderr),
    parserFailed: false,
    cleanupUncertain: false,
  };
}

function unavailable(message: string): AppleProcessResult {
  return {
    termination: "unavailable",
    exitCode: null,
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(message),
    parserFailed: false,
    cleanupUncertain: false,
  };
}
