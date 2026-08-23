import type { ProviderDriverKind, ProviderInstance, ProviderInstanceId } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";

const PREFERRED_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  "ollama",
  "codex",
  "opencode",
  "claude",
  "kimi-code",
  "grok",
];

export function hasSelectableProviderModels(groups: ReadonlyArray<PickerGroup>): boolean {
  return groups.some((group) => group.sections.some((section) => section.models.length > 0));
}

export function shouldRunProviderBootstrap(input: {
  readonly enabled: boolean;
  readonly providerStatus: "loading" | "ready" | "disconnected";
  readonly scanning: boolean;
  readonly attempted: boolean;
  readonly hasSelectableModels: boolean;
  readonly hasUnobservedProviders: boolean;
}): boolean {
  return (
    input.enabled &&
    input.providerStatus === "ready" &&
    !input.scanning &&
    !input.attempted &&
    (!input.hasSelectableModels || input.hasUnobservedProviders)
  );
}

export function listAutoProbeInstanceIds(
  instances: ReadonlyArray<ProviderInstance>,
  observedInstanceIds: ReadonlySet<ProviderInstanceId>,
): ReadonlyArray<ProviderInstanceId> {
  return instances
    .filter((instance) => instance.enabled && !observedInstanceIds.has(instance.id))
    .toSorted((left, right) => {
      const leftRank = PREFERRED_DRIVERS.indexOf(left.driverKind);
      const rightRank = PREFERRED_DRIVERS.indexOf(right.driverKind);
      return (
        (leftRank === -1 ? PREFERRED_DRIVERS.length : leftRank) -
        (rightRank === -1 ? PREFERRED_DRIVERS.length : rightRank)
      );
    })
    .map((instance) => instance.id);
}
