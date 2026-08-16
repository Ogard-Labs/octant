import type { HostHealth, HostId, HostIdentity } from "@octant/contracts/host";
import { LOCAL_HOST_DISPLAY_NAME, LOCAL_HOST_ID } from "@octant/contracts/host";

// ── Types ───────────────────────────────────────────────────────────────────

export interface HostSelectionRequest {
  readonly requestedHostId?: HostId;
  readonly projectHostId?: HostId;
}

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
 * Pure host-selection policy for the v1 single-implicit-host server model.
 *
 * Client create surfaces use `hostCreateSelectionPolicy` for multi-host
 * destination choice (Post-preview B4). This module remains the server-side
 * fail-closed registry until federation routes commands to remote hosts.
 *
 * - Returns exactly one healthy implicit host (`This Mac`) when no specific
 *   host is requested or when the local host is requested.
 * - An existing Project fixes the host: if `projectHostId` is present, the
 *   selection must match it.
 * - Fails closed for any unknown or non-local host.
 */
export function selectHost(request: HostSelectionRequest): HostSelectionResult {
  const targetId = request.requestedHostId ?? request.projectHostId ?? LOCAL_HOST_ID;

  const host = KNOWN_HOSTS.get(targetId);
  if (host === undefined) {
    return { kind: "rejected", reason: "unknown-host" };
  }

  if (!isRoutable(host.health)) {
    return { kind: "rejected", reason: healthToRejection(host.health) };
  }

  if (
    request.projectHostId !== undefined &&
    request.requestedHostId !== undefined &&
    request.projectHostId !== request.requestedHostId
  ) {
    return { kind: "rejected", reason: "project-host-mismatch" };
  }

  return { kind: "selected", host };
}

/**
 * Returns the full list of known hosts for the v1 selector UI.
 * In v1 this is always exactly one healthy `This Mac` entry.
 */
export function listHosts(): ReadonlyArray<HostIdentity> {
  return [...KNOWN_HOSTS.values()];
}

/**
 * Validates that a hostId is known and routable. Used by the server to
 * reauthorize creation commands with host identity present.
 */
export function assertHostRoutable(hostId: HostId): HostIdentity {
  const host = KNOWN_HOSTS.get(hostId);
  if (host === undefined) {
    throw new HostNotRoutableError("unknown-host", hostId);
  }
  if (!isRoutable(host.health)) {
    throw new HostNotRoutableError(healthToRejection(host.health), hostId);
  }
  return host;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRoutable(health: HostHealth): boolean {
  return health === "healthy";
}

function healthToRejection(health: HostHealth): HostRejectionReason {
  switch (health) {
    case "unavailable":
    case "stale":
    case "connecting":
      return "host-unavailable";
    case "unauthorized":
      return "host-unauthorized";
    case "incompatible":
      return "host-incompatible";
    case "healthy":
      return "host-unavailable";
  }
}

export class HostNotRoutableError extends Error {
  readonly reason: HostRejectionReason;
  readonly hostId: HostId;

  constructor(reason: HostRejectionReason, hostId: HostId) {
    super(`Host ${hostId} is not routable: ${reason}`);
    this.name = "HostNotRoutableError";
    this.reason = reason;
    this.hostId = hostId;
  }
}
