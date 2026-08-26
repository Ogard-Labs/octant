import { execSync } from "node:child_process";

export type ComputerUseDestinationReport =
  | { readonly status: "available"; readonly kind: "macos-host" }
  | { readonly status: "unavailable"; readonly kind: "no-destination" | "no-provider-configured" };

export type ComputerUseDestinationRefusal = {
  readonly status: "refused";
  readonly kind: "unavailable";
  readonly reason: "no-destination" | "no-provider-configured";
};

export function reportComputerUseDestination(input: {
  readonly platform: NodeJS.Platform;
  readonly hasScreen?: boolean;
  readonly providerConfigured?: boolean;
}): ComputerUseDestinationReport {
  if (input.platform === "darwin") {
    if (input.hasScreen === false) {
      return { status: "unavailable", kind: "no-destination" };
    }
    return { status: "available", kind: "macos-host" };
  }
  if (input.providerConfigured === true) {
    return { status: "unavailable", kind: "no-destination" };
  }
  return { status: "unavailable", kind: "no-provider-configured" };
}

export function refuseComputerUseDestination(
  destination: ComputerUseDestinationReport,
): ComputerUseDestinationRefusal | undefined {
  if (destination.status === "available") return undefined;
  return {
    status: "refused",
    kind: "unavailable",
    reason: destination.kind,
  };
}

/**
 * Detect whether the macOS host has a usable screen. Returns `false` on
 * headless Darwin (SSH, CI runners without a WindowServer session). The
 * check asks WindowServer for the main display via osascript; failure is
 * treated as no screen so the caller never throws.
 */
export function detectMacOsScreen(): boolean {
  try {
    const result = execSync(
      '/usr/bin/osascript -l JavaScript -e "ObjC.import(\\"CoreGraphics\\"); $.CGMainDisplayID()"',
      { timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const id = Number.parseInt(String(result).trim(), 10);
    return Number.isFinite(id) && id > 0;
  } catch {
    return false;
  }
}

export function isComputerUseDestinationRefusal(
  result: unknown,
): result is ComputerUseDestinationRefusal {
  if (typeof result !== "object" || result === null) return false;
  if (!("status" in result) || !("kind" in result) || !("reason" in result)) return false;
  return (
    result.status === "refused" &&
    result.kind === "unavailable" &&
    (result.reason === "no-destination" || result.reason === "no-provider-configured")
  );
}
