import {
  forgetHostCredential,
  type RemoteDeviceKeyStore,
  type RemoteSessionBridge,
  type RemotePairingApproval,
} from "@octant/client-runtime";
import type {
  MobileHostRegistration,
  MobileHostRegistry,
  MobileHostRegistryRead,
} from "../hosts/HostRegistry";
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
}): Promise<MobileHostRegistryRead | undefined> {
  if (input.signal.aborted) return undefined;
  const read = await input.registry.list();
  if (input.signal.aborted) return undefined;
  // An unreadable list says nothing about which hosts are paired, so the live
  // sessions stay as they are instead of being torn down.
  if (read.kind === "ok") input.hub.syncRegistrations(read.hosts);
  return read;
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
  const remaining = await input.registry.list();
  if (remaining.kind === "ok") input.hub.syncRegistrations(remaining.hosts);
  try {
    await forgetHostCredential(input.deviceKeyStore, registration);
  } catch {
    return { localCredentialRemoved: false };
  }
  return { localCredentialRemoved: true };
}

/**
 * Removals one after another. The host registry and the device key catalog each
 * read the whole list, drop one entry, and write it back, so two removals that
 * overlap can each write from the old list and bring the other host back.
 */
export function createMobileHostRemover(
  input: Omit<Parameters<typeof removeMobileHost>[0], "hostId">,
): (hostId: string) => Promise<RemoveMobileHostResult> {
  let last: Promise<unknown> = Promise.resolve();
  return (hostId) => {
    const run = last.then(() => removeMobileHost({ ...input, hostId }));
    last = run.catch(() => undefined);
    return run;
  };
}
