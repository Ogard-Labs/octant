import { describe, expect, it, vi } from "vitest";
import {
  createWindowsRosterSigningKeyFile,
  type WindowsRosterSigningKeyNative,
} from "./windowsRosterSigningKey";
import type { WindowsHostProfilePaths } from "./windowsHostProfile";

const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile: "octant",
  profileId: "11111111-1111-4111-8111-111111111111",
  rootDirectory: "C:\\owned\\Octant\\hosts\\octant",
  dataDirectory: "C:\\owned\\Octant\\hosts\\octant\\data",
  configDirectory: "C:\\owned\\Octant\\hosts\\octant\\config",
  stateDirectory: "C:\\owned\\Octant\\hosts\\octant\\state",
  logsDirectory: "C:\\owned\\Octant\\hosts\\octant\\logs",
};
function native(
  operation: (...args: ReadonlyArray<unknown>) => unknown,
): WindowsRosterSigningKeyNative {
  return {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    poll: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    lookup: vi.fn(),
    beginRequest: vi.fn(),
    pollRequest: vi.fn(),
    closeRequest: vi.fn(),
    rosterSigningKeyFile: operation,
  };
}
describe("Windows roster signing storage", () => {
  it("binds one closed key operation to the exact native profile and erases its transfer buffer", () => {
    const raw = Buffer.from("private fixture");
    const operation = vi.fn(() => ({
      status: "ready",
      dataDirectory: paths.dataDirectory,
      bytes: raw,
    }));
    const file = createWindowsRosterSigningKeyFile(native(operation), paths);
    const result = file?.read();
    expect(operation).toHaveBeenCalledWith(
      paths.profile,
      paths.profileId,
      paths.dataDirectory,
      null,
    );
    expect(result?.status).toBe("ready");
    if (result?.status === "ready")
      expect(result.bytes.equals(Buffer.from("private fixture"))).toBe(true);
    expect(raw.every((byte) => byte === 0)).toBe(true);
  });
  it("refuses an incompatible binding, mismatched native path and invalid candidate before mutation", () => {
    const { rosterSigningKeyFile: ignored, ...old } = native(vi.fn());
    void ignored;
    expect(createWindowsRosterSigningKeyFile(old, paths)).toBeUndefined();
    const raw = Buffer.from("private fixture");
    const wrong = createWindowsRosterSigningKeyFile(
      native(() => ({ status: "ready", dataDirectory: "C:\\other", bytes: raw })),
      paths,
    );
    expect(wrong?.read()).toEqual({ status: "refused" });
    expect(raw.every((byte) => byte === 0)).toBe(true);
    const operation = vi.fn();
    const file = createWindowsRosterSigningKeyFile(native(operation), paths);
    expect(file?.create(Buffer.alloc(0))).toEqual({ status: "refused" });
    expect(file?.create(Buffer.alloc(4097))).toEqual({ status: "refused" });
    expect(operation).not.toHaveBeenCalled();
  });
});
