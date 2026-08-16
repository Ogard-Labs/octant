import {
  decodeRemoteOwnDeviceMetadataV1,
  decodeRemoteSelfServiceReceiptV1,
  type RemoteOwnDeviceMetadataV1,
} from "@octant/contracts";
import { buildRemoteKeyRotationProofPayload } from "@octant/domain";
import type { RemoteSessionBridge, StagedDeviceKeyRotation } from "./remoteSessionBridge";
import { canExecuteRemoteProductMutation } from "./remoteShellHealth";

export class RemoteDeviceSelfServiceFailure extends Error {
  readonly category: "offline" | "rejected" | "unavailable";

  constructor(category: "offline" | "rejected" | "unavailable", message: string) {
    super(message);
    this.name = "RemoteDeviceSelfServiceFailure";
    this.category = category;
  }
}

export interface RemoteRotateDeviceKeyResult {
  /** Fingerprint of the key the host now accepts for this device. */
  readonly newDeviceKeyFingerprint: string;
  /** Credential generation the host advanced this device to. */
  readonly credentialGeneration: number;
  /** A non-fatal warning when the host rotated but local persistence did not. */
  readonly warning?: string;
}

export interface RemoteRevokeSelfResult {
  /** Whether the browser removed the credential after the host revoked it. */
  readonly localCredentialRemoved: boolean;
  /** A non-fatal warning when the host revoke succeeded but local cleanup did not. */
  readonly warning?: string;
}

function guardAuthenticatedConnection(
  bridge: RemoteSessionBridge,
): NonNullable<ReturnType<RemoteSessionBridge["connection"]>> {
  if (!canExecuteRemoteProductMutation(bridge.getState())) {
    throw new RemoteDeviceSelfServiceFailure(
      "offline",
      "Octant is disconnected. Reconnect before managing this device.",
    );
  }
  const connection = bridge.connection();
  if (connection === undefined || connection.session() === undefined) {
    throw new RemoteDeviceSelfServiceFailure(
      "offline",
      "No authenticated remote session is available.",
    );
  }
  return connection;
}

async function decodeSelfServiceResponse(
  response: Response,
  failureMessage: string,
): Promise<void> {
  if (!response.ok) {
    throw new RemoteDeviceSelfServiceFailure(
      response.status === 403 ? "rejected" : "unavailable",
      failureMessage,
    );
  }
  try {
    decodeRemoteSelfServiceReceiptV1(await response.json());
  } catch {
    throw new RemoteDeviceSelfServiceFailure(
      "unavailable",
      `${failureMessage} The host returned an invalid response.`,
    );
  }
}

/** Read bounded metadata for the authenticated device only. */
export async function fetchRemoteOwnDeviceMetadata(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<RemoteOwnDeviceMetadataV1> {
  const connection = guardAuthenticatedConnection(input.bridge);
  const response = await connection.authenticatedFetch({
    method: "GET",
    path: "/api/remote/auth/device",
  });
  if (!response.ok) {
    throw new RemoteDeviceSelfServiceFailure(
      response.status === 403 ? "rejected" : "unavailable",
      "Own-device metadata is unavailable over the remote session.",
    );
  }
  try {
    return decodeRemoteOwnDeviceMetadataV1(await response.json());
  } catch {
    throw new RemoteDeviceSelfServiceFailure(
      "unavailable",
      "Own-device metadata response was invalid.",
    );
  }
}

/** Sign out the current remote session without revoking the device registration. */
export async function remoteSignOut(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<void> {
  const connection = guardAuthenticatedConnection(input.bridge);
  const response = await connection.authenticatedFetch({
    method: "POST",
    path: "/api/remote/auth/sign-out",
    body: "{}",
  });
  await decodeSelfServiceResponse(response, "Remote sign-out failed.");
  connection.disconnect();
}

/**
 * Rotate this browser's device key — the remedy when the current key may be
 * compromised.
 *
 * The host accepts the replacement only because *both* keys prove possession:
 * the old key signs the request proof that authenticates this call, and the new
 * key signs the canonical rotation transcript carried in `newKeyProof`. Neither
 * proof substitutes for the other, so a caller holding only a candidate public
 * key cannot displace a registration.
 *
 * The replacement key is staged locally before the host is asked, and adopted
 * only after the host confirms. A rejected or failed rotation therefore leaves
 * the old key as the stored one and this browser still able to authenticate.
 *
 * Rotation invalidates every session for the device, so the connection is torn
 * down here rather than left looking alive: the caller must re-authenticate
 * (`resume` picks up the newly stored registration).
 */
export async function remoteRotateDeviceKey(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<RemoteRotateDeviceKeyResult> {
  const connection = guardAuthenticatedConnection(input.bridge);
  const identity = connection.deviceIdentity();
  if (identity === undefined) {
    throw new RemoteDeviceSelfServiceFailure(
      "offline",
      "No authenticated remote session is available.",
    );
  }

  let staged: StagedDeviceKeyRotation;
  try {
    staged = await input.bridge.stageDeviceKeyRotation();
  } catch {
    throw new RemoteDeviceSelfServiceFailure(
      "unavailable",
      "This browser could not create a replacement device key. The current key is unchanged.",
    );
  }

  try {
    const newKeyProof = await staged.sign(
      buildRemoteKeyRotationProofPayload({
        hostId: identity.hostId,
        deviceId: identity.deviceId,
        credentialGeneration: identity.credentialGeneration,
        newDeviceKeyFingerprint: staged.fingerprint,
        newDevicePublicKey: staged.publicKeyPem,
      }),
    );
    const response = await connection.authenticatedFetch({
      method: "POST",
      path: "/api/remote/auth/rotate-key",
      body: JSON.stringify({
        newDeviceKeyFingerprint: staged.fingerprint,
        newDevicePublicKey: staged.publicKeyPem,
        newKeyProof,
      }),
    });
    await decodeSelfServiceResponse(response, "Remote device key rotation failed.");
  } catch (error) {
    await staged.discard().catch(() => undefined);
    if (isRemoteDeviceSelfServiceFailure(error)) throw error;
    throw new RemoteDeviceSelfServiceFailure(
      "unavailable",
      "Remote device key rotation failed. The current key is unchanged.",
    );
  }

  // The host rejects a rotation whose stated generation is not the device's
  // current one, so a confirmed rotation advanced exactly this generation by
  // one. Storing it keeps the next authentication challenge acceptable.
  const credentialGeneration = identity.credentialGeneration + 1;
  let warning: string | undefined;
  try {
    await staged.adopt({ credentialGeneration });
  } catch {
    warning =
      "The host rotated this device's key, but this browser could not store the replacement. Pair this browser again.";
  }
  input.bridge.disconnect();
  return {
    newDeviceKeyFingerprint: staged.fingerprint,
    credentialGeneration,
    ...(warning === undefined ? {} : { warning }),
  };
}

/** Revoke this browser device. Requires re-pairing before reconnect. */
export async function remoteRevokeSelf(input: {
  readonly bridge: RemoteSessionBridge;
}): Promise<RemoteRevokeSelfResult> {
  const connection = guardAuthenticatedConnection(input.bridge);
  const response = await connection.authenticatedFetch({
    method: "POST",
    path: "/api/remote/auth/revoke-self",
    body: "{}",
  });
  await decodeSelfServiceResponse(response, "Remote device revoke failed.");
  let cleanupError: unknown;
  try {
    await input.bridge.forgetDeviceKey();
  } catch (error) {
    cleanupError = error;
  } finally {
    input.bridge.disconnect();
  }
  if (cleanupError !== undefined) {
    return {
      localCredentialRemoved: false,
      warning: "Remote device was revoked, but this browser could not remove its local credential.",
    };
  }
  return { localCredentialRemoved: true };
}

export function isRemoteDeviceSelfServiceFailure(
  error: unknown,
): error is RemoteDeviceSelfServiceFailure {
  return error instanceof RemoteDeviceSelfServiceFailure;
}
