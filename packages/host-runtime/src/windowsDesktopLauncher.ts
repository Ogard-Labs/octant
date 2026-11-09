import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

interface WindowsDesktopLauncherNative extends WindowsHostProfileNative {
  readonly desktopLauncher: (
    profile: "octant",
    scope: string,
    dataDirectory: string,
    operation: "record" | "launch",
  ) => Promise<unknown>;
}
interface LauncherObservation {
  readonly reason?:
    | "cleanup-unconfirmed"
    | "deadline-exceeded"
    | "invalid-record"
    | "native-unavailable"
    | "owner-unavailable"
    | "profile-unavailable"
    | "unsafe-artifact";
  readonly elapsedMs?: number;
  readonly scannedEntries?: number;
}
export interface WindowsDesktopLauncher {
  readonly record: () => Promise<LauncherObservation & { readonly status: "recorded" | "refused" }>;
  readonly launch: () => Promise<
    LauncherObservation & { readonly status: "started" | "missing" | "refused" }
  >;
}
function launcherNative(native: WindowsHostProfileNative): native is WindowsDesktopLauncherNative {
  return "desktopLauncher" in native && typeof native.desktopLauncher === "function";
}

function reason(value: unknown): LauncherObservation["reason"] {
  switch (value) {
    case "cleanup-unconfirmed":
    case "deadline-exceeded":
    case "invalid-record":
    case "native-unavailable":
    case "owner-unavailable":
    case "profile-unavailable":
    case "unsafe-artifact":
      return value;
    default:
      return undefined;
  }
}
function measurement(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The native profile selects a fixed record and executable; callers supply neither. */
export function createWindowsDesktopLauncher(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsDesktopLauncher | undefined {
  if (paths.profile !== "octant" || !launcherNative(native)) return undefined;
  const invoke = async (
    operation: "record" | "launch",
  ): Promise<LauncherObservation & { readonly status: unknown }> => {
    try {
      const value: unknown = await native.desktopLauncher(
        "octant",
        paths.profileId,
        paths.dataDirectory,
        operation,
      );
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("status" in value)
      )
        return { status: "refused" };
      const refusedReason = "reason" in value ? reason(value.reason) : undefined;
      return {
        status: value.status,
        ...(refusedReason === undefined ? {} : { reason: refusedReason }),
        ...("elapsedMs" in value && measurement(value.elapsedMs)
          ? { elapsedMs: value.elapsedMs }
          : {}),
        ...("scannedEntries" in value && measurement(value.scannedEntries)
          ? { scannedEntries: value.scannedEntries }
          : {}),
      };
    } catch {
      return { status: "refused" };
    }
  };
  return {
    record: async () => {
      const value = await invoke("record");
      return { ...value, status: value.status === "recorded" ? "recorded" : "refused" };
    },
    launch: async () => {
      const value = await invoke("launch");
      return {
        ...value,
        status: value.status === "started" || value.status === "missing" ? value.status : "refused",
      };
    },
  };
}
