import type { HostIdentity, HostPlatform } from "@octant/contracts/host";
import { LOCAL_HOST_DISPLAY_NAME, LOCAL_HOST_ID } from "@octant/contracts/host";

// ── Types ───────────────────────────────────────────────────────────────────

export type HostSelectionResult =
  | { readonly kind: "selected"; readonly host: HostIdentity }
  | { readonly kind: "rejected"; readonly reason: HostRejectionReason };

export type HostRejectionReason =
  | "unknown-host"
  | "host-unavailable"
  | "host-unauthorized"
  | "host-incompatible"
  | "project-host-mismatch";

// ── V1 single-host registry ─────────────────────────────────────────────────

const LOCAL_HOST: HostIdentity = {
  hostId: LOCAL_HOST_ID,
  displayName: LOCAL_HOST_DISPLAY_NAME,
  health: "healthy",
  capabilities: ["chat", "work", "code"],
};

const KNOWN_HOSTS: ReadonlyMap<string, HostIdentity> = new Map([[LOCAL_HOST_ID, LOCAL_HOST]]);

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * Returns the full list of known hosts for the v1 selector UI.
 * In v1 this is always exactly one healthy local entry. The caller supplies the
 * platform it runs on; this module does no I/O, so it cannot read it.
 */
export function listHosts(
  displayName = LOCAL_HOST_DISPLAY_NAME,
  platform?: HostPlatform,
): ReadonlyArray<HostIdentity> {
  const localHost = KNOWN_HOSTS.get(LOCAL_HOST_ID);
  if (localHost === undefined) return [];
  return [{ ...localHost, displayName, ...(platform === undefined ? {} : { platform }) }];
}
