import { describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import {
  acquireWindowsHostProfileOwner,
  type WindowsHostProfileNative,
} from "./windowsHostProfile";

const profileId = "11111111-1111-4111-8111-111111111111";
const root = "C:\\Users\\fixture\\AppData\\Local\\Octant\\hosts\\octant";
const endpoint = "\\\\.\\pipe\\Octant-host-" + "a".repeat(64);
function fixture(facts: Readonly<Record<string, unknown>> = {}) {
  let receipt: unknown;
  const native: WindowsHostProfileNative = {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: vi.fn(() => ({
      status: "ready",
      profile: "octant",
      profileId,
      rootDirectory: root,
      dataDirectory: win32.join(root, "data"),
      configDirectory: win32.join(root, "config"),
      stateDirectory: win32.join(root, "state"),
      logsDirectory: win32.join(root, "logs"),
      ...facts,
    })),
    prepare: vi.fn(() => ({
      status: "prepared",
      pid: 4242,
      processStart: "win32:0000000100000002",
      endpoint,
    })),
    claim: (value) => {
      receipt = JSON.parse(value.toString("utf8"));
      return { status: "owned" };
    },
    poll: () => ({ status: "idle" }),
    reply: () => ({ status: "accepted" }),
    close: vi.fn(() => ({ status: "closed" })),
    lookup: () => ({ status: "missing" }),
    beginRequest: () => ({ status: "refused" }),
    pollRequest: () => ({ status: "refused" }),
    closeRequest: () => ({ status: "closed" }),
  };
  return { native, receipt: () => receipt };
}
const identity = {
  profile: "octant",
  env: {},
  instanceId: "22222222-2222-4222-8222-222222222222",
  serverVersion: "1",
  wireVersion: "1",
  serviceMode: "foreground",
} as const;

describe("Windows persistent profile ownership", () => {
  it("uses the native persisted profile for the actual control owner and its data paths", async () => {
    const fake = fixture();
    const result = await acquireWindowsHostProfileOwner({ ...identity, native: fake.native });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected profile ownership");
    try {
      expect(fake.native.prepare).toHaveBeenCalledExactlyOnceWith(profileId);
      expect(fake.receipt()).toMatchObject({ hostId: profileId, pid: 4242 });
      expect(result.paths).toMatchObject({ profileId, dataDirectory: win32.join(root, "data") });
      expect(result.ownership.kind).toBe("owner");
    } finally {
      if (result.ownership.kind === "owner") await result.ownership.release();
    }
  });

  it("refuses unsupported explicit stores before opening a profile instead of choosing another one", async () => {
    const fake = fixture();
    for (const env of [{ OCTANT_DATA_DIR: "D:\\other" }, { OCTANT_LOGS_DIR: "" }]) {
      expect(
        await acquireWindowsHostProfileOwner({ ...identity, native: fake.native, env }),
      ).toEqual({
        status: "refused",
        reason: "path-override",
      });
    }
    expect(fake.native.openProfile).not.toHaveBeenCalled();
    expect(fake.native.prepare).not.toHaveBeenCalled();
  });

  it("refuses substituted native facts and never creates an owner on a different profile path", async () => {
    for (const facts of [
      { dataDirectory: "D:\\other" },
      { rootDirectory: "C:\\Users\\fixture\\elsewhere" },
      { profile: "nightly-test-data" },
      { profileId: "not-a-profile" },
      { status: "refused" },
    ]) {
      const fake = fixture(facts);
      expect(await acquireWindowsHostProfileOwner({ ...identity, native: fake.native })).toEqual({
        status: "refused",
        reason: "profile-unavailable",
      });
      expect(fake.native.prepare).not.toHaveBeenCalled();
    }
  });

  it("keeps an unavailable owner refused without returning writable profile paths", async () => {
    const fake = fixture();
    vi.mocked(fake.native.prepare).mockReturnValue({ status: "refused" });
    expect(await acquireWindowsHostProfileOwner({ ...identity, native: fake.native })).toEqual({
      status: "refused",
      reason: "owner-unavailable",
    });
  });
});
