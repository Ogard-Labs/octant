import { decodeHostId } from "@octant/contracts/host";
import type { ClientHostRegistry } from "./hostFederationRegistry";
import type { RemotePairingApproval } from "./remotePairingClient";

/**
 * Persist a freshly paired remote host in the client federation registry.
 *
 * Pairing already stores the device key; the registry holds only non-secret
 * identity and a credential handle so Settings can reconnect, revoke, or
 * remove that host without inventing a second trust path (0013 / 0059).
 */
export async function registerPairedRemoteHost(input: {
  readonly registry: ClientHostRegistry;
  readonly approval: RemotePairingApproval;
  readonly displayName: string;
  readonly hostKeyFingerprint: string;
}): Promise<void> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new Error("Paired remote hosts require a display name.");
  }
  if (input.hostKeyFingerprint.length === 0) {
    throw new Error("Paired remote hosts require a host key fingerprint.");
  }
  await input.registry.upsertRemote({
    hostId: decodeHostId(input.approval.hostId),
    kind: "remote",
    displayName,
    origin: input.approval.origin,
    enabled: true,
    credential: {
      keyId: input.approval.deviceKeyId,
      credentialGeneration: input.approval.credentialGeneration,
      hostKeyFingerprint: input.hostKeyFingerprint,
      deviceId: input.approval.deviceId,
    },
  });
}
