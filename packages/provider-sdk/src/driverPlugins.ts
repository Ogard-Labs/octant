import type { ProviderDriverKind } from "@octant/contracts";
import {
  DISCOVERY_DESCRIPTORS,
  discoverableDescriptors,
  type ProviderDiscoveryDescriptor,
} from "./discovery";

/**
 * How an in-tree vendor driver reaches the host.
 *
 * ACP vendors configure the single host ACP stack; they do not ship a second
 * protocol runtime. Managed-process and direct-endpoint drivers keep their
 * existing host adapters behind the shared `ProviderDriver` interface.
 */
export type ProviderDriverHostRuntime = "acp-host-profile" | "managed-process" | "direct-endpoint";

const ACP_HOST_PROFILE_DRIVER_KINDS: ReadonlySet<ProviderDriverKind> = new Set([
  "kilo",
  "devin",
  "mistral-vibe",
  "kimi-code",
  "grok",
]);

export function providerDriverHostRuntime(
  driverKind: ProviderDriverKind,
): ProviderDriverHostRuntime {
  if (ACP_HOST_PROFILE_DRIVER_KINDS.has(driverKind)) return "acp-host-profile";
  const descriptor = DISCOVERY_DESCRIPTORS.find((entry) => entry.driverKind === driverKind);
  if (descriptor?.isDirectEndpoint === true) return "direct-endpoint";
  return "managed-process";
}

export function isAcpHostProfileDriver(driverKind: ProviderDriverKind): boolean {
  return providerDriverHostRuntime(driverKind) === "acp-host-profile";
}

export function discoveryDescriptorsForAdmittedDrivers(
  admittedDriverKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ProviderDiscoveryDescriptor> {
  return DISCOVERY_DESCRIPTORS.filter((descriptor) =>
    admittedDriverKinds.has(descriptor.driverKind),
  );
}

export function discoverableDescriptorsForAdmittedDrivers(
  admittedDriverKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ProviderDiscoveryDescriptor> {
  return discoverableDescriptors().filter((descriptor) =>
    admittedDriverKinds.has(descriptor.driverKind),
  );
}
