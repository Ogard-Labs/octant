import { describe, expect, it, vi } from "vitest";
import {
  createWindowsAuthorityStateFiles,
  type WindowsAuthorityStateNative,
} from "./windowsAuthorityState";
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
function fixture(payload: Buffer): WindowsAuthorityStateNative {
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
    beginAuthorityState: vi.fn(() => ({
      status: "opened",
      session: 1,
      length: payload.length,
      dataDirectory: paths.dataDirectory,
    })),
    readAuthorityState: vi.fn((_session, offset) => {
      const bytes = Buffer.from(payload.subarray(offset, offset + 16384));
      return { status: "read", offset: offset + bytes.length, bytes };
    }),
    writeAuthorityState: vi.fn((_session, offset, bytes) => ({
      status: "written",
      offset: offset + bytes.length,
    })),
    commitAuthorityState: vi.fn(() => ({ status: "committed" })),
    closeAuthorityState: vi.fn(() => ({ status: "closed" })),
  };
}
describe("bounded native authority transfers", () => {
  it("preserves bytes across chunk boundaries and binds every store to one closed native purpose", () => {
    const payload = Buffer.from("a".repeat(16383) + "🔒");
    const native = fixture(payload);
    const files = createWindowsAuthorityStateFiles(native, paths);
    for (const [key, purpose] of [
      ["hub", "hub-state"],
      ["delegations", "delegations"],
      ["certificate", "tailscale-certificate"],
    ] as const) {
      const result = files?.[key].read();
      expect(result?.status).toBe("ready");
      if (result?.status === "ready") expect(result.bytes.equals(payload)).toBe(true);
      expect(native.beginAuthorityState).toHaveBeenLastCalledWith(
        paths.profile,
        paths.profileId,
        paths.dataDirectory,
        purpose,
        "read",
        null,
      );
      expect(files?.[key].replace(payload)).toEqual({ status: "committed" });
    }
    for (const call of vi.mocked(native.writeAuthorityState).mock.calls)
      expect(call[2].length).toBeLessThanOrEqual(16384);
    expect(payload.at(-1)).not.toBe(0);
  });
  it("refuses truncated, wrong-offset and failed-close transfers and always closes their session", () => {
    for (const bad of ["truncated", "offset", "close"] as const) {
      const native = fixture(Buffer.from("private"));
      if (bad === "close")
        vi.mocked(native.closeAuthorityState).mockReturnValue({ status: "refused" });
      else
        vi.mocked(native.readAuthorityState).mockReturnValue({
          status: "read",
          offset: bad === "offset" ? 99 : 7,
          bytes: Buffer.from(bad === "truncated" ? "x" : "private"),
        });
      expect(createWindowsAuthorityStateFiles(native, paths)?.hub.read()).toEqual({
        status: "refused",
      });
      expect(native.closeAuthorityState).toHaveBeenCalledWith(1);
    }
  });
  it("refuses invalid lengths and mismatched roots without a payload allocation or transfer", () => {
    for (const response of [
      { length: Number.MAX_SAFE_INTEGER + 1, dataDirectory: paths.dataDirectory },
      { length: 1, dataDirectory: "C:\\other" },
    ]) {
      const native = fixture(Buffer.from("x"));
      vi.mocked(native.beginAuthorityState).mockReturnValue({
        status: "opened",
        session: 1,
        ...response,
      });
      expect(createWindowsAuthorityStateFiles(native, paths)?.hub.read()).toEqual({
        status: "refused",
      });
      expect(native.readAuthorityState).not.toHaveBeenCalled();
      expect(native.closeAuthorityState).toHaveBeenCalledWith(1);
    }
  });
});
