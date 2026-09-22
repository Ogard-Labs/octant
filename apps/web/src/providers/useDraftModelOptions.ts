import { useState } from "react";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
} from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { readRememberedModelOptions } from "./modelChoiceMemory";

/** Draft remounts restore valid preferences; existing threads keep their authoritative values. */
export function useDraftModelOptions(
  groups: ReadonlyArray<PickerGroup>,
  providerInstanceId: ProviderInstanceId | undefined,
  modelId: ProviderModelId | undefined,
) {
  const modelKey = `${providerInstanceId ?? ""}:${modelId ?? ""}`;
  const selection =
    providerInstanceId === undefined || modelId === undefined
      ? undefined
      : { providerInstanceId, modelId };
  const [choice, setModelChoice] = useState<{
    readonly key: string;
    readonly values: ProviderModelOptionValues;
  }>();
  if (choice !== undefined && choice.key !== modelKey) setModelChoice(undefined);
  const modelOptionValues =
    choice?.key === modelKey ? choice.values : readRememberedModelOptions(groups, selection);
  return { modelKey, modelOptionValues, setModelChoice };
}
