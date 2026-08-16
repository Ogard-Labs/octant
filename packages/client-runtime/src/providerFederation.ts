import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderRegistrySnapshot,
} from "@octant/contracts";

export type HostId = string & { readonly __octantHostId: unique symbol };

export function hostId(value: string): HostId {
  return value as HostId;
}

export interface ProviderModelRef {
  readonly hostId: HostId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export interface HostQualifiedRegistrySnapshot {
  readonly hostId: HostId;
  readonly snapshot: ProviderRegistrySnapshot;
}

export function createProviderModelRef(
  host: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
): ProviderModelRef {
  return { hostId: host, providerInstanceId, modelId };
}

export function providerModelRefEquals(left: ProviderModelRef, right: ProviderModelRef): boolean {
  return (
    left.hostId === right.hostId &&
    String(left.providerInstanceId) === String(right.providerInstanceId) &&
    String(left.modelId) === String(right.modelId)
  );
}

export function hostQualifiedRegistrySnapshot(
  snapshot: ProviderRegistrySnapshot,
  host: HostId,
): HostQualifiedRegistrySnapshot {
  return { hostId: host, snapshot };
}

export function listProviderModelRefs(
  qualified: HostQualifiedRegistrySnapshot,
): ReadonlyArray<ProviderModelRef> {
  const enabledInstances = new Set(
    qualified.snapshot.instances
      .filter((instance) => instance.enabled)
      .map((instance) => String(instance.id)),
  );
  const nonReadyInstances = new Set(
    (qualified.snapshot.observedStates ?? [])
      .filter((state) => state.readiness !== "ready")
      .map((state) => String(state.instanceId)),
  );
  const catalogs = qualified.snapshot.catalogs ?? [];
  const refs: ProviderModelRef[] = [];
  for (const catalog of catalogs) {
    const instanceKey = String(catalog.instanceId);
    if (!enabledInstances.has(instanceKey)) continue;
    if (nonReadyInstances.has(instanceKey)) continue;
    if (catalog.invalidated) continue;
    for (const model of catalog.models) {
      refs.push(createProviderModelRef(qualified.hostId, catalog.instanceId, model.id));
    }
  }
  return refs;
}
