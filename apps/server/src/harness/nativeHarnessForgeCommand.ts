import {
  type ForgeShellHardLine,
  forgeShellChanges,
  FORGE_SHELL_TOOL_REQUIRED_MESSAGE,
  forgeShellHardLine,
  forgeShellHardLineMessage,
} from "@octant/domain/forge-shell-change-policy";
import type { NativeHarnessCompositionOptions } from "./nativeHarnessComposition";

/** Ordinary forge admission and audit, with no tool execution or secret callback. */
export function admitNativeHarnessForgeCommand(input: {
  readonly threadId: string;
  readonly command: string;
  readonly fullAccess: boolean;
  readonly forge: NativeHarnessCompositionOptions["forgeChanges"];
}) {
  const { threadId, command, forge } = input;
  const changes = forgeShellChanges(command);
  if (changes.length === 0)
    return { status: "admitted", recordRan: () => "no-change" as const } as const;
  const fullAccess = input.fullAccess;
  let hardLine: ForgeShellHardLine | undefined;
  let branchUnavailable = false;
  if (fullAccess) {
    try {
      if (forge === undefined) branchUnavailable = true;
      hardLine = forgeShellHardLine(
        changes,
        forge?.branches(threadId) ?? { otherThreadBranches: [] },
      );
    } catch {
      branchUnavailable = true;
      hardLine = forgeShellHardLine(changes, { otherThreadBranches: [] });
    }
  }
  if (
    !fullAccess ||
    hardLine !== undefined ||
    (branchUnavailable && changes.some((change) => change.kind === "push"))
  ) {
    try {
      forge?.record({
        threadId,
        changes,
        outcome: "refused",
        hardLine,
        command: command,
      });
    } catch {
      // The refusal stands whether or not its record could be kept.
    }
    return {
      status: "refused",
      refusal: {
        reason:
          hardLine !== undefined
            ? `forge-${hardLine}`
            : fullAccess
              ? "forge-authority-unavailable"
              : "forge-tool-required",
        message:
          hardLine !== undefined
            ? forgeShellHardLineMessage(hardLine)
            : fullAccess
              ? "Octant could not verify which branches other threads own, so this push was refused. Retry when repository authority is available."
              : FORGE_SHELL_TOOL_REQUIRED_MESSAGE,
      },
    } as const;
  }
  const recordRan = (exitCode: number | undefined) => {
    try {
      return forge?.record({
        threadId,
        changes,
        outcome: "ran",
        command: command,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    } catch {
      return "unavailable";
    }
  };
  return { status: "admitted", recordRan } as const;
}
