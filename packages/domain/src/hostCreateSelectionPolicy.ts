import type { HostHealth, HostId, HostIdentity } from "@octant/contracts/host";
import type { HostRejectionReason, HostSelectionResult } from "./hostPolicy";

/**
 * Pure create-time host selection for Chat / Work / Code (Post-preview B4).
 *
 * The selector is always present and remains changeable until create. An
 * existing Project fixes host ownership permanently. Unhealthy hosts stay
 * visible but disabled with a concrete reason. Single-host preview may
 * collapse the interactive UI while still accepting multi-host input.
 */

export type CreateHostViewScope =
  | { readonly kind: "all-hosts" }
  | { readonly kind: "host-filter"; readonly hostId: HostId };

export interface CreateHostOption {
  readonly host: HostIdentity;
  readonly selectable: boolean;
  readonly disabledReason?: string;
  /** Present when an existing Project fixes this host. */
  readonly fixed?: boolean;
}

export interface ListCreateHostOptionsRequest {
  readonly requiredCapability?: string;
  readonly projectHostId?: HostId;
}

export interface PreselectCreateHostRequest {
  readonly hosts: ReadonlyArray<HostIdentity>;
  readonly viewScope?: CreateHostViewScope;
  readonly lastSelectedHealthyHostId?: HostId;
  readonly projectHostId?: HostId;
  readonly requiredCapability?: string;
}

export interface SelectCreateHostRequest {
  readonly hosts: ReadonlyArray<HostIdentity>;
  readonly requestedHostId: HostId;
  readonly projectHostId?: HostId;
  readonly requiredCapability?: string;
}

export function hostCreateDisableReason(
  host: HostIdentity,
  requiredCapability?: string,
): string | undefined {
  if (requiredCapability !== undefined && !host.capabilities.includes(requiredCapability)) {
    return `Does not support ${requiredCapability}`;
  }
  switch (host.health) {
    case "healthy":
      return undefined;
    case "connecting":
      return "Connecting";
    case "stale":
      return "Stale connection";
    case "incompatible":
      return "Incompatible host";
    case "unauthorized":
      return "Unauthorized";
    case "unavailable":
      return "Host unavailable";
  }
}

export function listCreateHostOptions(
  hosts: ReadonlyArray<HostIdentity>,
  request: ListCreateHostOptionsRequest = {},
): ReadonlyArray<CreateHostOption> {
  return hosts.map((host) => {
    const fixed =
      request.projectHostId !== undefined && host.hostId === request.projectHostId
        ? true
        : undefined;
    const disabledReason = hostCreateDisableReason(host, request.requiredCapability);
    if (disabledReason === undefined) {
      return fixed === true ? { host, selectable: true, fixed: true } : { host, selectable: true };
    }
    return fixed === true
      ? { host, selectable: false, disabledReason, fixed: true }
      : { host, selectable: false, disabledReason };
  });
}

export function preselectCreateHost(request: PreselectCreateHostRequest): HostSelectionResult {
  const hosts = request.hosts;
  if (request.projectHostId !== undefined) {
    const projectHost = findHost(hosts, request.projectHostId);
    if (projectHost === undefined) {
      return { kind: "rejected", reason: "unknown-host" };
    }
    // Project ownership is immutable: surface the fixed host even when unhealthy
    // so the selector can render it disabled with a concrete reason.
    return { kind: "selected", host: projectHost };
  }

  const viewScope = request.viewScope ?? { kind: "all-hosts" };
  if (viewScope.kind === "host-filter") {
    const filtered = findHost(hosts, viewScope.hostId);
    if (filtered === undefined) {
      return { kind: "rejected", reason: "unknown-host" };
    }
    return { kind: "selected", host: filtered };
  }

  if (request.lastSelectedHealthyHostId !== undefined) {
    const last = findHost(hosts, request.lastSelectedHealthyHostId);
    if (last !== undefined && isRoutableForCreate(last, request.requiredCapability)) {
      return { kind: "selected", host: last };
    }
  }

  const firstHealthy = hosts.find((candidate) =>
    isRoutableForCreate(candidate, request.requiredCapability),
  );
  if (firstHealthy !== undefined) {
    return { kind: "selected", host: firstHealthy };
  }

  return { kind: "rejected", reason: "host-unavailable" };
}

export function selectCreateHost(request: SelectCreateHostRequest): HostSelectionResult {
  if (request.projectHostId !== undefined && request.requestedHostId !== request.projectHostId) {
    return { kind: "rejected", reason: "project-host-mismatch" };
  }

  const host = findHost(request.hosts, request.requestedHostId);
  if (host === undefined) {
    return { kind: "rejected", reason: "unknown-host" };
  }

  if (
    request.requiredCapability !== undefined &&
    !host.capabilities.includes(request.requiredCapability)
  ) {
    return { kind: "rejected", reason: "host-incompatible" };
  }

  if (!isRoutable(host.health)) {
    return { kind: "rejected", reason: healthToRejection(host.health) };
  }

  return { kind: "selected", host };
}

function findHost(hosts: ReadonlyArray<HostIdentity>, hostId: HostId): HostIdentity | undefined {
  return hosts.find((candidate) => candidate.hostId === hostId);
}

function isRoutable(health: HostHealth): boolean {
  return health === "healthy";
}

function isRoutableForCreate(host: HostIdentity, requiredCapability: string | undefined): boolean {
  if (!isRoutable(host.health)) return false;
  if (requiredCapability === undefined) return true;
  return host.capabilities.includes(requiredCapability);
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
