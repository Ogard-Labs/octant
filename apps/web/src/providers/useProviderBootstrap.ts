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
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const hasSelectableModels = hasSelectableProviderModels(options.providerGroups);

  useEffect(() => {
    if (
      !options.enabled ||
      hasSelectableModels ||
      (options.providerController.status === "disconnected" && !inFlight.current)
    ) {
      attempted.current = false;
    }
    if (
      !shouldRunProviderBootstrap({
        enabled: options.enabled,
        providerStatus: options.providerController.status,
        scanning: options.discoveryController.scanning,
        attempted: attempted.current,
        hasSelectableModels,
      })
    ) {
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    attempted.current = true;

    void (async () => {
      try {
        await options.discoveryController.scan();
        const autoProbeInstanceIds = listAutoProbeInstanceIds(
          options.providerController.readInstances(),
          new Set(options.providerController.observedByInstance.keys()),
        );
        for (const instanceId of autoProbeInstanceIds) {
          if (await options.providerController.probe(instanceId)) return;
        }
      } finally {
        inFlight.current = false;
      }
    })();
  }, [
    hasSelectableModels,
    options.enabled,
    options.discoveryController,
    options.providerController,
    options.discoveryController.scanning,
    options.discoveryController.snapshot,
    options.providerController.status,
    options.providerController.instances,
  ]);
}
