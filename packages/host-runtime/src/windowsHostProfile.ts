import { win32 } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { HostRuntimeOwnerResult } from "./owner";
import {
  acquireWindowsHostRuntimeOwner,
  loadWindowsHostOwnerNative,
  type AcquireWindowsHostOwnerOptions,
  type WindowsHostOwnerNative,
} from "./windowsHostOwner";

export type WindowsHostProfile = "octant" | "nightly-test-data";
export interface WindowsHostProfileNative extends WindowsHostOwnerNative {
  readonly openProfile: (profile: WindowsHostProfile) => unknown;
}
export interface WindowsHostProfilePaths {
  readonly platform: "win32";
  readonly profile: WindowsHostProfile;
  /** Persistent storage/control-scope metadata; never the remote signing identity. */
  readonly profileId: string;
  readonly rootDirectory: string;
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly stateDirectory: string;
  readonly logsDirectory: string;
}
export type AcquireWindowsHostProfileOptions = Omit<
  AcquireWindowsHostOwnerOptions,
  "native" | "scope" | "hostId"
> & {
  readonly native: WindowsHostProfileNative;
  readonly profile: WindowsHostProfile;
  readonly env?: Readonly<Record<string, string | undefined>>;
};
export type WindowsHostProfileOwnership =
  | {
      readonly status: "ready";
      readonly paths: WindowsHostProfilePaths;
      readonly ownership: HostRuntimeOwnerResult;
    }
  | {
      readonly status: "refused";
      readonly reason: "path-override" | "profile-unavailable" | "owner-unavailable";
    };

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function profileNative(value: WindowsHostOwnerNative): value is WindowsHostProfileNative {
  return "openProfile" in value && typeof value.openProfile === "function";
}
export function loadWindowsHostProfileNative(path: string): WindowsHostProfileNative | undefined {
  const native = loadWindowsHostOwnerNative(path);
  return native !== undefined && profileNative(native) ? native : undefined;
}
function profilePaths(
  value: unknown,
  profile: WindowsHostProfile,
): WindowsHostProfilePaths | undefined {
  if (!record(value) || value.status !== "ready" || value.profile !== profile) return undefined;
  const { profileId, rootDirectory } = value;
  if (
    typeof profileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profileId) ||
    typeof rootDirectory !== "string" ||
    !/^(?:\\\\\?\\)?[a-z]:\\/i.test(rootDirectory) ||
    rootDirectory.includes("\0") ||
    win32.normalize(rootDirectory) !== rootDirectory ||
    win32.basename(rootDirectory).toLowerCase() !== profile ||
    win32.basename(win32.dirname(rootDirectory)).toLowerCase() !== "hosts" ||
    win32.basename(win32.dirname(win32.dirname(rootDirectory))).toLowerCase() !== "octant"
  )
    return undefined;
  for (const [key, name] of Object.entries({
    dataDirectory: "data",
    configDirectory: "config",
    stateDirectory: "state",
    logsDirectory: "logs",
  })) {
    if (value[key] !== win32.join(rootDirectory, name)) return undefined;
  }
  return Object.freeze({
    platform: "win32",
    profile,
    profileId,
    rootDirectory,
    dataDirectory: win32.join(rootDirectory, "data"),
    configDirectory: win32.join(rootDirectory, "config"),
    stateDirectory: win32.join(rootDirectory, "state"),
    logsDirectory: win32.join(rootDirectory, "logs"),
  });
}

/** Acquire control from native persistent profile facts without admitting host startup. */
export async function acquireWindowsHostProfileOwner(
  options: AcquireWindowsHostProfileOptions,
): Promise<WindowsHostProfileOwnership> {
  const env = options.env ?? process.env;
  if (env.OCTANT_DATA_DIR !== undefined || env.OCTANT_LOGS_DIR !== undefined)
    return { status: "refused", reason: "path-override" };
  if (!isMainThread || (options.profile !== "octant" && options.profile !== "nightly-test-data"))
    return { status: "refused", reason: "profile-unavailable" };
  let paths: WindowsHostProfilePaths | undefined;
  try {
    paths = profilePaths(options.native.openProfile(options.profile), options.profile);
  } catch {
    return { status: "refused", reason: "profile-unavailable" };
  }
  if (paths === undefined) return { status: "refused", reason: "profile-unavailable" };
  try {
    const ownership = await acquireWindowsHostRuntimeOwner({
      native: options.native,
      scope: paths.profileId,
      hostId: paths.profileId,
      instanceId: options.instanceId,
      serverVersion: options.serverVersion,
      wireVersion: options.wireVersion,
      serviceMode: options.serviceMode,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onStopRequested === undefined
        ? {}
        : { onStopRequested: options.onStopRequested }),
      ...(options.onControlRequest === undefined
        ? {}
        : { onControlRequest: options.onControlRequest }),
    });
    return { status: "ready", paths, ownership };
  } catch {
    return { status: "refused", reason: "owner-unavailable" };
  }
}
