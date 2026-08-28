import { describe, expect, it, vi } from "vitest";
import { resolveDesktopCredentialBackend } from "./desktopCredentialStore";

const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";
const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";

describe("resolveDesktopCredentialBackend", () => {
  it("selects the Keychain helper store on macOS", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "darwin",
      keychainHelperPath: helperPath,
      storeScope,
      probe: vi.fn(),
    });
    expect(backend.kind).toBe("keychain");
    expect(backend.store).toBeDefined();
    expect(backend.purgeStore).toBeDefined();
  });

  it("selects Secret Service on Linux when the session store answers", async () => {
    const probe = vi.fn(async () => ({
      available: true,
      service: "available" as const,
      tool: "available" as const,
    }));
    const backend = await resolveDesktopCredentialBackend({
      platform: "linux",
      keychainHelperPath: helperPath,
      storeScope,
      probe,
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(backend).toEqual({
      kind: "secret-service",
      store: expect.any(Object),
    });
    expect(backend.purgeStore).toBeUndefined();
  });

  it("reports unavailable on Linux when Secret Service is missing", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "linux",
      keychainHelperPath: helperPath,
      storeScope,
      probe: async () => ({
        available: false,
        service: "unavailable",
        tool: "unavailable",
      }),
    });
    expect(backend).toEqual({ kind: "unavailable" });
  });

  it("does not invent a Windows credential store yet", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "win32",
      keychainHelperPath: helperPath,
      storeScope,
      probe: vi.fn(),
    });
    expect(backend).toEqual({ kind: "unavailable" });
  });
});
