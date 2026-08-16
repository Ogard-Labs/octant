import { describe, expect, it, vi } from "vitest";
import { unlockAppVault, type DeviceAuthenticator } from "./AppVault";

function authenticator(input: {
  readonly available: boolean;
  readonly outcome?: "confirmed" | "denied" | "unavailable";
}): DeviceAuthenticator {
  return {
    hasDeviceCredential: vi.fn(async () => input.available),
    authenticate: vi.fn(async () => input.outcome ?? "confirmed"),
  };
}

describe("app vault", () => {
  it("unlocks only after device-owner authentication", async () => {
    const port = authenticator({ available: true, outcome: "confirmed" });

    await expect(unlockAppVault(port)).resolves.toEqual({ status: "unlocked" });
    expect(port.authenticate).toHaveBeenCalledWith(expect.objectContaining({ reason: "unlock" }));
  });

  it("stays locked when authentication is cancelled or unavailable", async () => {
    await expect(
      unlockAppVault(authenticator({ available: true, outcome: "denied" })),
    ).resolves.toEqual({ status: "locked", reason: "Authentication cancelled." });
    await expect(unlockAppVault(authenticator({ available: false }))).resolves.toEqual({
      status: "locked",
      reason: "Set a device passcode or biometric before opening Octant.",
    });
  });

  it("fails closed when the native authentication port throws", async () => {
    const port = authenticator({ available: true });
    vi.mocked(port.hasDeviceCredential).mockRejectedValueOnce(new Error("native unavailable"));

    await expect(unlockAppVault(port)).resolves.toEqual({
      status: "locked",
      reason: "Device authentication is unavailable right now.",
    });
  });
});
