export type DeviceAuthenticationReason = "unlock" | "approve" | "reject" | "merge" | "revoke";

export interface DeviceAuthenticator {
  readonly hasDeviceCredential: () => Promise<boolean>;
  readonly authenticate: (input: {
    readonly reason: DeviceAuthenticationReason;
    readonly promptMessage: string;
  }) => Promise<"confirmed" | "denied" | "unavailable">;
}

export type AppVaultUnlockResult =
  | { readonly status: "unlocked" }
  | { readonly status: "locked"; readonly reason: string };

export async function unlockAppVault(
  authenticator: DeviceAuthenticator,
): Promise<AppVaultUnlockResult> {
  let hasDeviceCredential: boolean;
  try {
    hasDeviceCredential = await authenticator.hasDeviceCredential();
  } catch {
    return {
      status: "locked",
      reason: "Device authentication is unavailable right now.",
    };
  }
  if (!hasDeviceCredential) {
    return {
      status: "locked",
      reason: "Set a device passcode or biometric before opening Octant.",
    };
  }
  let outcome: Awaited<ReturnType<DeviceAuthenticator["authenticate"]>>;
  try {
    outcome = await authenticator.authenticate({
      reason: "unlock",
      promptMessage: "Unlock Octant",
    });
  } catch {
    outcome = "unavailable";
  }
  if (outcome === "confirmed") return { status: "unlocked" };
  if (outcome === "denied") {
    return { status: "locked", reason: "Authentication cancelled." };
  }
  return {
    status: "locked",
    reason: "Device authentication is unavailable right now.",
  };
}
