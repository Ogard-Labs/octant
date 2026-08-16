import { LOCAL_HOST_ID, type HostId, type HostIdentity } from "@octant/contracts/host";
import { decodeHostId } from "@octant/contracts/host";

export const CREATE_HOST_LAST_HEALTHY_STORAGE_KEY = "octant.create.last-healthy-host.v1";

export function readLastSelectedHealthyHostId(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): HostId | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(CREATE_HOST_LAST_HEALTHY_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return undefined;
    return decodeHostId(raw);
  } catch {
    return undefined;
  }
}

export function writeLastSelectedHealthyHostId(
  hostId: HostId,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(CREATE_HOST_LAST_HEALTHY_STORAGE_KEY, String(hostId));
  } catch {
    // Preference persistence is best-effort; create still proceeds.
  }
}

export function rememberHealthyCreateHost(
  host: HostIdentity,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): HostId | undefined {
  if (host.health !== "healthy") return undefined;
  writeLastSelectedHealthyHostId(host.hostId, storage);
  return host.hostId;
}

export function defaultCreateHostId(): HostId {
  return LOCAL_HOST_ID;
}
