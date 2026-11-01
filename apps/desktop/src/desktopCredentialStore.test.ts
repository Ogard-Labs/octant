import { describe, expect, it } from "vitest";
import { resolveDesktopCredentialBackend } from "./desktopCredentialStore";

const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";
const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";

describe("resolveDesktopCredentialBackend", () => {
  it("selects the Keychain helper store on macOS", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "darwin",
      keychainHelperPath: helperPath,
      storeScope,
    });
    expect(backend.kind).toBe("keychain");
    expect(backend.store).toBeDefined();
    expect(backend.purgeStore).toBeDefined();
  });

  it("selects Secret Service on Linux without waiting for a keyring to answer", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "linux",
      keychainHelperPath: helperPath,
      storeScope,
    });
    expect(backend).toEqual({
      kind: "secret-service",
      store: expect.any(Object),
      replicaDeviceKeys: expect.any(Object),
      replicaStoreCredentials: expect.any(Object),
      canvasPublicShareSecrets: expect.any(Object),
      mcpServerCredentials: expect.any(Object),
      desktopProviderCredentials: expect.any(Object),
      pushPlatformCredentials: expect.any(Object),
      sshKeys: expect.any(Object),
    });
    expect(backend.purgeStore).toBeUndefined();
  });

  it("uses Credential Manager on Windows", async () => {
    const backend = await resolveDesktopCredentialBackend({
      platform: "win32",
      keychainHelperPath: helperPath,
      storeScope,
    });
    expect(backend.kind).toBe("credential-manager");
    expect(backend.store).toBeDefined();
  });
});
