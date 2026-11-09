import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export type RosterSigningKeyRead =
  | { readonly status: "ready"; readonly bytes: Buffer }
  | { readonly status: "missing" | "refused" };

/** Internal storage only. The roster's public port exposes signatures and SPKI. */
export interface WindowsRosterSigningKeyFile {
  readonly dataDirectory: string;
  readonly read: () => RosterSigningKeyRead;
  readonly create: (bytes: Buffer) => RosterSigningKeyRead;
}

export interface WindowsRosterSigningKeyNative extends WindowsHostProfileNative {
  readonly rosterSigningKeyFile: (
    profile: string,
    scope: string,
    dataDirectory: string,
    candidate: Buffer | null,
  ) => unknown;
}

export function createWindowsRosterSigningKeyFile(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsRosterSigningKeyFile | undefined {
  if (!("rosterSigningKeyFile" in native) || typeof native.rosterSigningKeyFile !== "function")
    return undefined;
  const operation = native.rosterSigningKeyFile.bind(native);
  const access = (candidate: Buffer | null): RosterSigningKeyRead => {
    if (candidate !== null && (candidate.length === 0 || candidate.length > 4096))
      return { status: "refused" };
    let result: unknown;
    try {
      result = operation(paths.profile, paths.profileId, paths.dataDirectory, candidate);
    } catch {
      return { status: "refused" };
    }
    if (typeof result !== "object" || result === null || !("status" in result))
      return { status: "refused" };
    if (result.status === "missing") return { status: "missing" };
    if (
      result.status !== "ready" ||
      !("dataDirectory" in result) ||
      result.dataDirectory !== paths.dataDirectory ||
      !("bytes" in result) ||
      !(result.bytes instanceof Uint8Array) ||
      result.bytes.length === 0 ||
      result.bytes.length > 4096
    ) {
      if ("bytes" in result && result.bytes instanceof Uint8Array) result.bytes.fill(0);
      return { status: "refused" };
    }
    const bytes = Buffer.from(result.bytes);
    result.bytes.fill(0);
    return { status: "ready", bytes };
  };
  return Object.freeze({
    dataDirectory: paths.dataDirectory,
    read: () => access(null),
    create: access,
  });
}
