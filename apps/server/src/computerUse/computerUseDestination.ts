import { execSync } from "node:child_process";
import type { LeasableDesktopProvider } from "@octant/contracts";

/**
 * Where computer use can act on this host. A Mac with a screen is a
 * destination of its own; a disposable desktop becomes one only once a thread
 * leases it, so a host whose only option is a desktop provider reports which
 * providers it could lease from rather than an available destination.
 */
export type ComputerUseDestinationReport =
  | {
      readonly status: "available";
      readonly kind: "macos-host";
      readonly leasable?: ReadonlyArray<LeasableDesktopProvider>;
    }
  | {
      readonly status: "leasable";
      readonly kind: "disposable-desktop";
      readonly leasable: ReadonlyArray<LeasableDesktopProvider>;
    }
  | { readonly status: "unavailable"; readonly kind: "no-destination" | "no-provider-configured" };

export type ComputerUseDestinationRefusal = {
  readonly status: "refused";
  readonly kind: "unavailable";
  readonly reason: "no-destination" | "no-provider-configured";
};

export function reportComputerUseDestination(input: {
  readonly platform: NodeJS.Platform;
  readonly hasScreen?: boolean;
  readonly leasable?: ReadonlyArray<LeasableDesktopProvider>;
}): ComputerUseDestinationReport {
  const leasable = input.leasable ?? [];
  if (input.platform === "darwin" && input.hasScreen !== false) {
    return leasable.length === 0
      ? { status: "available", kind: "macos-host" }
      : { status: "available", kind: "macos-host", leasable };
  }
  if (leasable.length > 0) return { status: "leasable", kind: "disposable-desktop", leasable };
  if (input.platform === "darwin") return { status: "unavailable", kind: "no-destination" };
  return { status: "unavailable", kind: "no-provider-configured" };
}

/**
 * The Mac runtime's refusal. A leasable provider is not a screen that runtime
 * can drive: until a send binds a lease, there is no destination.
 */
export function refuseComputerUseDestination(
  destination: ComputerUseDestinationReport,
): ComputerUseDestinationRefusal | undefined {
  if (destination.status === "available") return undefined;
  return {
    status: "refused",
    kind: "unavailable",
    reason: destination.status === "leasable" ? "no-destination" : destination.kind,
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
