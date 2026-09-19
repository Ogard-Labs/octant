import type { RemoteSessionBridge, RemotePairingApproval } from "@octant/client-runtime";
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
