import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export type ListenerTlsFile = "key" | "certificate";
export type ListenerTlsFileRead =
  | { readonly status: "ready"; readonly bytes: Buffer }
  | { readonly status: "missing" | "refused" | "exposed" };

/** Host-internal storage. Private bytes never enter the listener's public status. */
export interface WindowsListenerTlsFiles {
  readonly dataDirectory: string;
  readonly read: (purpose: ListenerTlsFile) => ListenerTlsFileRead;
  readonly createKey: (bytes: Buffer) => ListenerTlsFileRead;
  readonly replaceCertificate: (bytes: Buffer) => ListenerTlsFileRead;
}

export interface WindowsListenerTlsNative extends WindowsHostProfileNative {
  readonly listenerTlsFile: (
    profile: string,
    scope: string,
    dataDirectory: string,
    purpose: ListenerTlsFile,
    candidate: Buffer | null,
  ) => unknown;
}

export function createWindowsListenerTlsFiles(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsListenerTlsFiles | undefined {
  if (!("listenerTlsFile" in native) || typeof native.listenerTlsFile !== "function")
    return undefined;
  const operation = native.listenerTlsFile.bind(native);
  const access = (purpose: ListenerTlsFile, candidate: Buffer | null): ListenerTlsFileRead => {
    if (purpose !== "key" && purpose !== "certificate") return { status: "refused" };
    const maximum = purpose === "key" ? 4096 : 16384;
    if (candidate !== null && (candidate.length === 0 || candidate.length > maximum))
      return { status: "refused" };
    let result: unknown;
    try {
      result = operation(paths.profile, paths.profileId, paths.dataDirectory, purpose, candidate);
    } catch {
      return { status: "refused" };
    }
    if (typeof result !== "object" || result === null || !("status" in result))
      return { status: "refused" };
    if (result.status === "missing" || result.status === "exposed")
      return { status: result.status };
    if (
      result.status !== "ready" ||
      !("dataDirectory" in result) ||
      result.dataDirectory !== paths.dataDirectory ||
      !("bytes" in result) ||
      !(result.bytes instanceof Uint8Array) ||
      result.bytes.length > maximum ||
      (purpose === "key" && result.bytes.length === 0)
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
    read: (purpose: ListenerTlsFile) => access(purpose, null),
    createKey: (bytes: Buffer) => access("key", bytes),
    replaceCertificate: (bytes: Buffer) => access("certificate", bytes),
  });
}
