import type { ProviderInstanceId } from "@octant/contracts";
import type { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { ExtensionProviderFamily as ExtensionProviderFamilySchema } from "@octant/contracts/extensions";
import type { PickerGroup } from "@octant/domain";
import { Schema } from "effect";

export function providerFamilyForThread(
  groups: ReadonlyArray<PickerGroup> | undefined,
  providerInstanceId: ProviderInstanceId | undefined,
): ExtensionProviderFamily | undefined {
  const group = groups?.find(
    (candidate) => String(candidate.instance.id) === String(providerInstanceId),
  );
  return group !== undefined && Schema.is(ExtensionProviderFamilySchema)(group.instance.driverKind)
    ? group.instance.driverKind
    : undefined;
}

export function selectedProviderFamily(
  groups: ReadonlyArray<PickerGroup>,
  selectedProviderInstanceId: ProviderInstanceId | undefined,
): ExtensionProviderFamily | undefined {
  return providerFamilyForThread(groups, selectedProviderInstanceId);
}
