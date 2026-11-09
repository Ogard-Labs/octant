import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export type ServerIdentityFile = "host-id" | "host-key";
export type ServerIdentityFileRead =
  | { readonly status: "ready"; readonly bytes: Buffer }
  | { readonly status: "missing" }
  | { readonly status: "refused" };

/** Internal storage only. Public signing ports never expose these private bytes. */
export interface WindowsServerIdentityFiles {
  readonly dataDirectory: string;
  readonly read: (purpose: ServerIdentityFile) => ServerIdentityFileRead;
  readonly create: (purpose: ServerIdentityFile, bytes: Buffer) => ServerIdentityFileRead;
}
export interface WindowsServerIdentityNative extends WindowsHostProfileNative {
  readonly identityFile: (
    profile: string,
    scope: string,
    dataDirectory: string,
    purpose: ServerIdentityFile,
    candidate: Buffer | null,
  ) => unknown;
}

export function createWindowsServerIdentityFiles(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsServerIdentityFiles | undefined {
  if (!("identityFile" in native) || typeof native.identityFile !== "function") return undefined;
  const identityFile = native.identityFile.bind(native);
  function access(purpose: ServerIdentityFile, candidate: Buffer | null): ServerIdentityFileRead {
    if (purpose !== "host-id" && purpose !== "host-key") return { status: "refused" };
    const maximum = purpose === "host-id" ? 37 : 4096;
    if (candidate !== null && (candidate.length === 0 || candidate.length > maximum))
      return { status: "refused" };
    let value: unknown;
    try {
      value = identityFile(paths.profile, paths.profileId, paths.dataDirectory, purpose, candidate);
    } catch {
      return { status: "refused" };
    }
    if (typeof value !== "object" || value === null || !("status" in value))
      return { status: "refused" };
    if (value.status === "missing") return { status: "missing" };
    if (
      value.status !== "ready" ||
      !("dataDirectory" in value) ||
      value.dataDirectory !== paths.dataDirectory ||
      !("bytes" in value) ||
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.length === 0 ||
      value.bytes.length > maximum
    ) {
      if ("bytes" in value && value.bytes instanceof Uint8Array) value.bytes.fill(0);
      return { status: "refused" };
    }
    const bytes = Buffer.from(value.bytes);
    value.bytes.fill(0);
    return { status: "ready", bytes };
  }
  return Object.freeze({
    dataDirectory: paths.dataDirectory,
    read: (purpose: ServerIdentityFile) => access(purpose, null),
    create: (purpose: ServerIdentityFile, bytes: Buffer) => access(purpose, bytes),
  });
}
