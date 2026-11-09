import { describe, expect, it, vi } from "vitest";
import {
  createWindowsServerIdentityFiles,
  type WindowsServerIdentityNative,
} from "./windowsServerIdentity";
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
  identityFile: (...args: ReadonlyArray<unknown>) => unknown,
): WindowsServerIdentityNative {
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
    identityFile,
  };
}

describe("Windows server identity storage", () => {
  it("keeps native private bytes internal and supplies the exact profile authority on every operation", () => {
    const raw = Buffer.from("private fixture");
    const operation = vi.fn(() => ({
      status: "ready",
      dataDirectory: paths.dataDirectory,
      bytes: raw,
    }));
    const files = createWindowsServerIdentityFiles(native(operation), paths);
    const result = files?.read("host-key");
    expect(operation).toHaveBeenCalledWith(
      paths.profile,
      paths.profileId,
      paths.dataDirectory,
      "host-key",
      null,
    );
    expect(result?.status).toBe("ready");
    if (result?.status === "ready") expect(result.bytes.toString()).toBe("private fixture");
    expect(raw.every((byte) => byte === 0)).toBe(true);
  });
  it("refuses an incompatible binding or mismatched native root without exposing its bytes", () => {
    const base = native(vi.fn());
    const { identityFile: ignored, ...oldBinding } = base;
    void ignored;
    expect(createWindowsServerIdentityFiles(oldBinding, paths)).toBeUndefined();
    const bytes = Buffer.from("private fixture");
    const files = createWindowsServerIdentityFiles(
      native(() => ({ status: "ready", dataDirectory: "C:\\other", bytes })),
      paths,
    );
    expect(files?.read("host-key")).toEqual({ status: "refused" });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
  it("refuses an oversized candidate before any native mutation", () => {
    const operation = vi.fn();
    const files = createWindowsServerIdentityFiles(native(operation), paths);
    expect(files?.create("host-key", Buffer.alloc(4097))).toEqual({ status: "refused" });
    expect(files?.create("host-id", Buffer.alloc(38))).toEqual({ status: "refused" });
    expect(operation).not.toHaveBeenCalled();
  });
});
