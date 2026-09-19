import type { AppleSimulatorRecord, AppleSimulatorRequest } from "@octant/contracts";
import type { SimulatorInputCommand } from "@octant/contracts/computer-use-plugin";
import type { DesktopComputerUsePort } from "../computerUse/desktopComputerUsePort";
import type { AppleProcessResult, AppleToolchainServiceOptions } from "./appleToolchainService";

type InjectSimulatorInput = NonNullable<AppleToolchainServiceOptions["injectSimulatorInput"]>;

/**
 * Simulator input delivered through the desktop's computer-use broker, which
 * drives the device's Device Hub window with the embedded driver. The result
 * is shaped like a host process so the workbench evidence names a refusal the
 * same way it names a failed `simctl` call, and a broker that cannot be
 * reached reads as unavailable rather than failed.
 */
export function simulatorInputThroughDesktop(
  desktop: Pick<DesktopComputerUsePort, "simulatorInput">,
): InjectSimulatorInput {
  return async (request, _context, _timeoutMs, signal, destination) => {
    const command = simulatorInputCommand(request, destination);
    if (command.kind === "unavailable") return unavailable(command.message);
    try {
      const result = await desktop.simulatorInput(command.command, signal);
      return result.kind === "delivered"
        ? exited(0, result.detail, "")
        : exited(1, "", `${result.reason}: ${result.message}`);
    } catch {
      return unavailable(
        "Octant's desktop computer-use broker is unreachable; Simulator input needs the desktop app.",
      );
    }
  };
}

export function simulatorInputCommand(
  request: AppleSimulatorRequest,
  destination: AppleSimulatorRecord | undefined,
):
  | { readonly kind: "command"; readonly command: SimulatorInputCommand }
  | { readonly kind: "unavailable"; readonly message: string } {
  if (destination === undefined)
    return {
      kind: "unavailable",
      message: "The destination is unknown to the host; discover Simulators again.",
    };
  const simulator = { udid: destination.udid, name: destination.name };
  if (request.kind === "type-text" && request.text !== undefined)
    return { kind: "command", command: { kind: "type-text", ...simulator, text: request.text } };
  if (request.kind === "key-press" && request.key !== undefined)
    return { kind: "command", command: { kind: "key-press", ...simulator, key: request.key } };
  if (request.kind === "tap" && request.target !== undefined)
    return { kind: "command", command: { kind: "tap", ...simulator, target: request.target } };
  if (request.kind === "tap" && request.point !== undefined) {
    const { frameWidth, frameHeight } = request.point;
    if (frameWidth === undefined || frameHeight === undefined)
      return {
        kind: "unavailable",
        message:
          "A coordinate tap needs the size of the screenshot it was read from; the workbench pane sends it, or name a target.",
      };
    return {
      kind: "command",
      command: {
        kind: "tap",
        ...simulator,
        point: { x: request.point.x, y: request.point.y },
        frame: { width: frameWidth, height: frameHeight },
      },
    };
  }
  return {
    kind: "unavailable",
    message: "Simulator input request is incomplete for host injection.",
  };
}

function exited(exitCode: number, stdout: string, stderr: string): AppleProcessResult {
  return {
    termination: "exited",
    exitCode,
    stdout: new TextEncoder().encode(stdout),
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
