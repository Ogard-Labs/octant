import type { DiscoveryController } from "./useDiscoveryController";
import type { ProviderController } from "./useProviderController";
import { useEffect, useRef } from "react";
import {
  hasSelectableProviderModels,
  listAutoProbeInstanceIds,
  shouldRunProviderBootstrap,
} from "./providerBootstrapPolicy";
import type { PickerGroup } from "@octant/domain";

export interface ProviderBootstrapOptions {
  readonly discoveryController: DiscoveryController;
  readonly enabled: boolean;
  readonly providerController: ProviderController;
  readonly providerGroups: ReadonlyArray<PickerGroup>;
}

export function useProviderBootstrap(options: ProviderBootstrapOptions): void {
  const attemptedKey = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const hasSelectableModels = hasSelectableProviderModels(options.providerGroups);
  const unobservedProviderIds = listAutoProbeInstanceIds(
    options.providerController.instances,
    new Set(options.providerController.observedByInstance.keys()),
  );
  const bootstrapKey =
    unobservedProviderIds.length === 0
      ? "discover"
      : `probe:${unobservedProviderIds.map(String).join(",")}`;

  useEffect(() => {
    if (
      !shouldRunProviderBootstrap({
        enabled: options.enabled,
        providerStatus: options.providerController.status,
        scanning: options.discoveryController.scanning,
        attempted: attemptedKey.current === bootstrapKey,
        hasSelectableModels,
        hasUnobservedProviders: unobservedProviderIds.length > 0,
      })
    ) {
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    attemptedKey.current = bootstrapKey;

    void (async () => {
      try {
        await options.discoveryController.scan();
        const autoProbeInstanceIds = listAutoProbeInstanceIds(
          options.providerController.readInstances(),
          new Set(options.providerController.observedByInstance.keys()),
        );
        for (const instanceId of autoProbeInstanceIds) {
          await options.providerController.probe(instanceId);
        }
      } finally {
        inFlight.current = false;
      }
    })();
  }, [
    hasSelectableModels,
    bootstrapKey,
    unobservedProviderIds.length,
    options.enabled,
    options.discoveryController,
    options.providerController,
    options.discoveryController.scanning,
    options.discoveryController.snapshot,
    options.providerController.status,
    options.providerController.instances,
  ]);
}
