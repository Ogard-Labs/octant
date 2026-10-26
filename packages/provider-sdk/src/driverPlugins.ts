import { isAcpAgentKind, type ProviderDriverKind } from "@octant/contracts";
import {
  DISCOVERY_DESCRIPTORS,
  discoverableDescriptors,
  type ProviderDiscoveryDescriptor,
} from "./discovery";

/**
 * How a provider driver reaches the host.
 *
 * ACP vendors configure the single host ACP stack; they do not ship a second
 * protocol runtime. Managed-process and direct-endpoint drivers keep their
 * existing host adapters behind the shared `ProviderDriver` interface. An
 * outside driver package supplies only a harness endpoint transport, run by
 * the host in its own confined process; it launches nothing itself.
 */
export type ProviderDriverHostRuntime =
  | "acp-host-profile"
  | "managed-process"
  | "direct-endpoint"
  | "outside-endpoint";

export function providerDriverHostRuntime(
  driverKind: ProviderDriverKind,
): ProviderDriverHostRuntime {
  if (driverKind === "outside-harness-endpoint") return "outside-endpoint";
  if (isAcpAgentKind(driverKind)) return "acp-host-profile";
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
