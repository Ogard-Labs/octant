import {
  forgetHostCredential,
  type RemoteDeviceKeyStore,
  type RemoteSessionBridge,
  type RemotePairingApproval,
} from "@octant/client-runtime";
import type { MobileHostRegistration, MobileHostRegistry } from "../hosts/HostRegistry";
import type { MobileHostSessionHub } from "./MobileHostSessionHub";

export function disconnectLiveMobileSession(input: {
  readonly bridge: Pick<RemoteSessionBridge, "disconnect">;
  readonly hub: Pick<MobileHostSessionHub, "disconnectAll">;
}): void {
  input.hub.disconnectAll();
  input.bridge.disconnect();
}

export async function refreshLiveMobileSession(input: {
  readonly registry: Pick<MobileHostRegistry, "list">;
  readonly hub: Pick<MobileHostSessionHub, "syncRegistrations">;
  readonly signal: AbortSignal;
}): Promise<ReadonlyArray<MobileHostRegistration> | undefined> {
  if (input.signal.aborted) return undefined;
  const hosts = await input.registry.list();
  if (input.signal.aborted) return undefined;
  input.hub.syncRegistrations(hosts);
  return hosts;
}

export async function finishLiveMobilePairing(input: {
  readonly registry: Pick<MobileHostRegistry, "upsert">;
  readonly registration: MobileHostRegistration;
  readonly approval: RemotePairingApproval;
  readonly bridge: Pick<RemoteSessionBridge, "connect">;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  await input.registry.upsert(input.registration);
  if (input.signal.aborted) return false;
  input.bridge.connect(input.approval);
  return true;
}

export interface RemoveMobileHostResult {
  /** False when the host left the list but its device key could not be deleted. */
  readonly localCredentialRemoved: boolean;
}

/**
 * Take a host off the phone's list and delete what the phone holds for it: its
 * device key in secure storage and the live session on its bridge. Other hosts'
 * keys stay. The host leaves the list and its bridge stops before the key is
 * deleted, so nothing reconnects with a key that is going away. A key that
 * cannot be deleted is reported, not thrown, because the host is already gone
 * from the list and the person cannot retry from there.
 */
export async function removeMobileHost(input: {
  readonly hostId: string;
  readonly registry: Pick<MobileHostRegistry, "get" | "list" | "remove">;
  readonly hub: Pick<MobileHostSessionHub, "syncRegistrations">;
  readonly deviceKeyStore: Pick<RemoteDeviceKeyStore, "remove">;
}): Promise<RemoveMobileHostResult> {
  const registration = await input.registry.get(input.hostId);
  await input.registry.remove(input.hostId);
  input.hub.syncRegistrations(await input.registry.list());
  try {
    await forgetHostCredential(input.deviceKeyStore, registration);
  } catch {
    return { localCredentialRemoved: false };
  }
  return { localCredentialRemoved: true };
}
