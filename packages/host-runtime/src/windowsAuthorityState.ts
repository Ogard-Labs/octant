import type { WindowsHostProfileNative, WindowsHostProfilePaths } from "./windowsHostProfile";

export interface WindowsAuthorityStateFile {
  readonly dataDirectory: string;
  readonly read: () =>
    | { readonly status: "ready"; readonly bytes: Buffer }
    | { readonly status: "missing" | "refused" };
  readonly replace: (bytes: Buffer) => { readonly status: "committed" | "refused" };
}
export interface WindowsAuthorityStateFiles {
  readonly hub: WindowsAuthorityStateFile;
  readonly delegations: WindowsAuthorityStateFile;
  readonly certificate: WindowsAuthorityStateFile;
}
export interface WindowsAuthorityStateNative extends WindowsHostProfileNative {
  readonly beginAuthorityState: (
    profile: string,
    scope: string,
    dataDirectory: string,
    purpose: string,
    mode: "read" | "replace",
    length: number | null,
  ) => unknown;
  readonly readAuthorityState: (session: number, offset: number) => unknown;
  readonly writeAuthorityState: (session: number, offset: number, bytes: Buffer) => unknown;
  readonly commitAuthorityState: (session: number) => unknown;
  readonly closeAuthorityState: (session: number) => unknown;
}
type AuthorityResult =
  | { readonly status: "ready"; readonly bytes: Buffer }
  | { readonly status: "missing" }
  | { readonly status: "committed" }
  | { readonly status: "refused" };

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function authorityNative(native: WindowsHostProfileNative): native is WindowsAuthorityStateNative {
  return [
    "beginAuthorityState",
    "readAuthorityState",
    "writeAuthorityState",
    "commitAuthorityState",
    "closeAuthorityState",
  ].every((key) => key in native && typeof Reflect.get(native, key) === "function");
}
export function createWindowsAuthorityStateFiles(
  native: WindowsHostProfileNative,
  paths: WindowsHostProfilePaths,
): WindowsAuthorityStateFiles | undefined {
  if (!authorityNative(native)) return undefined;
  const file = (
    purpose: "hub-state" | "delegations" | "tailscale-certificate",
  ): WindowsAuthorityStateFile => {
    const access = (input: Buffer | null): AuthorityResult => {
      let session: number | undefined;
      let output: Buffer | undefined;
      let result: AuthorityResult = { status: "refused" };
      try {
        const opened = native.beginAuthorityState(
          paths.profile,
          paths.profileId,
          paths.dataDirectory,
          purpose,
          input === null ? "read" : "replace",
          input?.length ?? null,
        );
        if (!record(opened)) return result;
        if (opened.status === "missing" && input === null) return { status: "missing" };
        if (opened.status !== "opened" || !integer(opened.session)) return result;
        session = opened.session;
        if (
          opened.dataDirectory !== paths.dataDirectory ||
          !integer(opened.length) ||
          (input !== null && opened.length !== input.length)
        )
          return result;
        const length = opened.length;
        if (input === null) output = Buffer.alloc(length);
        for (let offset = 0; offset < length;) {
          const end = Math.min(length, offset + 16384);
          const transfer =
            input === null
              ? native.readAuthorityState(session, offset)
              : native.writeAuthorityState(session, offset, input.subarray(offset, end));
          if (!record(transfer)) return result;
          if (input === null) {
            if (transfer.status !== "read" || !(transfer.bytes instanceof Uint8Array))
              return result;
            try {
              if (
                transfer.bytes.length !== end - offset ||
                transfer.offset !== end ||
                output === undefined
              )
                return result;
              output.set(transfer.bytes, offset);
            } finally {
              transfer.bytes.fill(0);
            }
          } else if (transfer.status !== "written" || transfer.offset !== end) return result;
          offset = end;
        }
        if (input === null && output !== undefined) result = { status: "ready", bytes: output };
        else {
          const committed = native.commitAuthorityState(session);
          if (record(committed) && committed.status === "committed")
            result = { status: "committed" };
        }
      } catch {
        result = { status: "refused" };
      } finally {
        if (session !== undefined) {
          try {
            const closed = native.closeAuthorityState(session);
            if (!record(closed) || closed.status !== "closed") result = { status: "refused" };
          } catch {
            result = { status: "refused" };
          }
        }
        if (result.status !== "ready") output?.fill(0);
      }
      return result;
    };
    return Object.freeze({
      dataDirectory: paths.dataDirectory,
      read: (): ReturnType<WindowsAuthorityStateFile["read"]> => {
        const result = access(null);
        return result.status === "committed" ? { status: "refused" } : result;
      },
      replace: (bytes: Buffer): ReturnType<WindowsAuthorityStateFile["replace"]> => {
        const result = access(bytes);
        if (result.status === "ready") result.bytes.fill(0);
        return { status: result.status === "committed" ? "committed" : "refused" };
      },
    });
  };
  return Object.freeze({
    hub: file("hub-state"),
    delegations: file("delegations"),
    certificate: file("tailscale-certificate"),
  });
}
